import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  canRunTasks,
  activeStatuses,
  MAX_TASK_CANDIDATES,
  findCycle,
  planTaskSchema,
  honeyBoost,
  isBlockedByFailure,
  isSafeCommand,
  shiftAllows,
  readyTasks,
  stateForTaskStatus,
  workerStateSchema,
  type AgentEvent,
  type AgentEventType,
  type CandidateCheck,
  type CandidateScore,
  type PlanTask,
  type ReviewComment,
  type Run,
  type RunStatus,
  type Task,
  type TaskResult,
  type Worker,
  type Workspace,
} from '@hive/core';
import type { AgentMemory, AgentRuntime, AgentTaskInput, RuntimeEvent } from '@hive/agents';
import type { Repositories } from '@hive/persistence';
import type { ChatClient } from '@hive/providers';
import { HiveError, clipText, errorMessage, newId, nowIso, secretRedactor } from '@hive/shared';
import {
  WorktreeManager,
  diffRefs,
  git,
  hiveCommitFlags,
  inspectRepository,
  isEnvironmentFailure,
  isHiveBranch,
  statusPorcelain,
  taskBranchName,
  type DiffResult,
} from '@hive/workspace';
import { failureSummary, newCandidate, pickWinner, type CandidateModel } from './candidates';
import { buildRunReport } from './report';

export interface SchedulerOptions {
  repos: Repositories;
  /** The engine that runs agents: Hive's own NativeAgentRuntime. */
  runtime: AgentRuntime;
  /**
   * The engine for one agent, when it is not the default: the place where another engine
   * implementing AgentRuntime (a permitted programmatic integration, for instance) plugs in
   * per agent. Without it, or when it returns null, every agent runs on `runtime`.
   */
  runtimeFor?: (worker: Worker) => AgentRuntime | null;
  chatFor: (providerId: string) => ChatClient;
  resolveSkills: (
    names: string[],
  ) => Promise<{ skills: AgentTaskInput['skills']; missing: string[] }>;
  /** Hive-owned folder for a workspace's task worktrees, outside the user's repository. */
  worktreeRoot: (workspace: Workspace) => string;
  onEvent: (event: AgentEvent) => void;
  onChange: (entity: 'run' | 'task' | 'approval', id: string) => void;
  /**
   * True while nobody is watching this run (shift mode). Commands outside the safe list are then
   * denied instead of waiting, and failed tasks are retried up to the configured attempts.
   */
  unattended?: (runId: string) => boolean;
  /**
   * Adaptive replanning. Called once a task has failed for good (after any automatic retries),
   * before the scheduler looks at what depends on it: a listener that wants to propose another
   * path registers it synchronously so that `holds` already answers true.
   */
  onTaskFailed?: (run: Run, task: Task) => void;
  /** Called once a task's attempt has ended (completed, failed or cancelled) and been saved. */
  onTaskFinished?: (run: Run, task: Task) => void;
  /**
   * True while a failed task waits for a replanning decision. Its dependents then stay pending
   * instead of being cancelled, and the run stays running until the decision is made.
   */
  holds?: (task: Task) => boolean;
  /**
   * The client an agent's task talks through, when it is more than its provider's: e.g. one that
   * moves to another provider or model when this one is exhausted. `notify` writes in the task log.
   */
  chatForWorker?: (
    worker: Worker,
    notify: (message: string, data: Record<string, unknown>) => void,
  ) => ChatClient;
  /**
   * Shared memory (the Nectar) for a task about to start: the safe point where context and change
   * notices are handed over. A failure here is logged and the task runs without memory.
   */
  prepareMemory?: (context: {
    run: Run;
    task: Task;
    worker: Worker;
  }) => Promise<{ memory: AgentMemory; summary: string } | null>;
  /**
   * Hive Teams: the tools and guidance a task's agent gets from its place in a team (a leader's
   * delegation tools, a reviewer's verdict). Handed over next to the Nectar's, through the same
   * memory channel of the runtime; null when the task is not part of a team.
   */
  teamTools?: (context: { run: Run; task: Task; worker: Worker }) => AgentMemory | null;
  /**
   * "Várias tentativas": up to `count` different models for an agent's candidates, its own first.
   * Only models that cost nothing extra. Without it (or with fewer than two), a task runs once.
   */
  candidateModels?: (worker: Worker, count: number) => CandidateModel[];
  /** Runs the project's checks on a candidate's result, to compare candidates. */
  checkCandidate?: (context: { run: Run; task: Task }) => Promise<CandidateCheck[]>;
}

/** Prefix of the error given to tasks skipped because a dependency did not succeed. */
const BLOCKED = 'Dependência não concluída';
const RESUMABLE: ReadonlySet<RunStatus> = new Set([
  'awaiting_plan_approval',
  'review',
  'failed',
  'cancelled',
]);
const NEEDS_RETRY: ReadonlySet<Task['status']> = new Set(['failed', 'cancelled']);
/** Runs whose plan can still take changes by hand: not one being planned or already closed. */
const EDITABLE: ReadonlySet<RunStatus> = new Set([
  'awaiting_plan_approval',
  'running',
  'review',
  'failed',
  'cancelled',
]);
/** Tasks that have not started: the only ones whose dependencies or agent may change. */
const NOT_STARTED: ReadonlySet<Task['status']> = new Set(['pending', 'blocked']);
/** A run planned by hand on top of the Queen's plan still stays a reviewable size. */
export const MAX_RUN_TASKS = 40;
/**
 * A task cut off this many times in a row is no longer resumed on its own: something in it may
 * be what brings Hive down (a command that exhausts the machine, for instance).
 */
export const MAX_INTERRUPTIONS = 3;

/**
 * Runs a planned mission. Each task gets its own worktree and `hive/` branch created from the
 * run's base commit plus the branches of its dependencies; the user's working tree is only
 * touched when they explicitly apply (approve) a finished task.
 */
export class Scheduler {
  /** taskId → runtime session id, for tasks whose agent is running. */
  private readonly sessions = new Map<string, string>();
  /** The engine each running task was started on, to cancel it on the same one. */
  private readonly runtimes = new Map<string, AgentRuntime>();
  /** Tasks between "picked" and "agent started" (worktree setup). */
  private readonly launching = new Set<string>();
  private readonly cancelRequested = new Set<string>();
  private readonly pendingApprovals = new Map<string, (approved: boolean) => void>();
  /**
   * Set when Hive is quitting: the attempts still going are left exactly as they are in the
   * database, for `recover` to save and resume at the next start, instead of being closed as
   * cancelled half-way while the process exits.
   */
  private closing = false;
  /** True while `recover` saves interrupted work: no task starts before its checkpoint exists. */
  private recovering = false;
  /** Tasks whose round of candidates is being compared right now. */
  private readonly choosing = new Set<string>();
  /** Task+try that runs once after all, for lack of models; so it is decided only once. */
  private readonly singleAttempt = new Set<string>();

  constructor(private readonly options: SchedulerOptions) {}

  private get repos() {
    return this.options.repos;
  }

  /**
   * Call once at startup, before anything starts tasks: nothing can still be running after Hive
   * closed or crashed. What each interrupted attempt had done is saved as a commit on its branch,
   * and runs that were going pick up from there, each task from its own saved work. Leftover
   * worktrees are removed. Returns the runs resumed.
   */
  async recover(): Promise<Run[]> {
    this.recovering = true;
    try {
      return await this.recoverInterrupted();
    } finally {
      this.recovering = false;
      // Also the runs started while recovering, which could not launch anything until now.
      this.pumpAll();
    }
  }

  private async recoverInterrupted(): Promise<Run[]> {
    for (const approval of this.repos.approvals.list("status = 'pending'"))
      this.repos.approvals.put({ ...approval, status: 'expired', resolvedAt: nowIso() });
    const resumed: Run[] = [];
    for (const run of this.repos.runs.list()) {
      const cut = this.repos.tasks
        .list('run_id = ?', run.id)
        .filter((task) => activeStatuses.has(task.status));
      for (const task of cut)
        this.update(
          task.id,
          run.status === 'running'
            ? { status: 'pending', workerState: 'idle', error: null, finishedAt: null }
            : // The run had already stopped (cancelled, for instance): the task was on its way out.
              {
                status: 'cancelled',
                workerState: 'cancelled',
                error: 'Interrompida quando o Hive fechou.',
                finishedAt: nowIso(),
              },
        );
      if (run.status === 'running') resumed.push(run);
    }
    // Every task that still names a worktree was cut off inside it, whatever its status says now.
    for (const task of this.repos.tasks.list()) if (task.worktreePath) await this.salvage(task);
    await this.removeLeftoverWorktrees();
    for (const run of resumed) {
      this.log(
        run,
        null,
        null,
        'run.status',
        'warn',
        'O Hive fechou no meio desta missão. Retomada de onde parou.',
      );
      this.options.onChange('run', run.id);
    }
    return resumed;
  }

  /**
   * Saves what an interrupted attempt changed as a commit on its branch and removes its
   * worktree. The task keeps a checkpoint, so its next attempt continues from that work. A task
   * cut off too many times in a row stops being resumed and waits for the user.
   */
  private async salvage(task: Task): Promise<void> {
    const worktree = task.worktreePath!;
    const run = this.repos.runs.get(task.runId);
    const workspace = run ? this.repos.workspaces.get(run.workspaceId) : null;
    let work: string | null = null;
    if (workspace) {
      const manager = new WorktreeManager(workspace.path, this.options.worktreeRoot(workspace));
      // Where this attempt began: without that, it never got as far as working.
      const began = task.checkpoint?.commit ?? task.revision?.fromCommit ?? task.startCommit;
      try {
        const saved = await manager.commitAll(worktree, `hive: ${task.title} (interrompida)`);
        // The agent may have committed by itself, so the branch's tip counts, not only new files.
        const head =
          saved ??
          (await git(worktree, ['rev-parse', 'HEAD'], { allowFailure: true })).stdout.trim();
        if (began && task.startCommit && head && head !== began) work = head;
      } catch {
        // The worktree is gone or unreadable: there is nothing left to save from it.
      }
      const branch = task.branch && isHiveBranch(task.branch) ? task.branch : null;
      await manager.remove(worktree, work ? null : branch).catch(() => undefined);
      // The new work was built on the earlier checkpoint, so its branch is no longer needed.
      const earlier = task.checkpoint?.branch;
      if (work && earlier && earlier !== task.branch && isHiveBranch(earlier))
        await git(workspace.path, ['branch', '-D', '--', earlier], { allowFailure: true });
    }
    const interruptions = (task.checkpoint?.interruptions ?? 0) + 1;
    const checkpoint = work
      ? {
          commit: work,
          branch: task.branch,
          startCommit: task.startCommit,
          interruptions,
          at: nowIso(),
        }
      : {
          commit: task.checkpoint?.commit ?? null,
          branch: task.checkpoint?.branch ?? null,
          startCommit: task.checkpoint?.startCommit ?? null,
          interruptions,
          at: nowIso(),
        };
    const giveUp = interruptions >= MAX_INTERRUPTIONS && task.status === 'pending';
    this.update(task.id, {
      worktreePath: null,
      checkpoint,
      ...(giveUp
        ? {
            status: 'failed',
            workerState: 'failed',
            error: `Interrompida ${interruptions} vezes seguidas, sempre no meio do trabalho. O que ela já fez está guardado; use Tentar de novo para continuar.`,
            finishedAt: nowIso(),
          }
        : {}),
    });
    if (run)
      this.log(
        run,
        task.id,
        task.workerId,
        'task.status',
        giveUp ? 'warn' : 'info',
        work
          ? `Trabalho da tentativa interrompida guardado (${work.slice(0, 8)}); a próxima continua dele.`
          : 'A tentativa interrompida não tinha alterado nada ainda.',
      );
  }

  /**
   * Worktrees in Hive's folder that no task owns: what a crash left behind. A check or delivery
   * worktree may be in use right now, so only old ones count. One with changes nobody committed
   * is marked `dirty`: it is never removed, since that work exists nowhere else.
   */
  async leftoverWorktrees(): Promise<{ workspaceId: string; path: string; dirty: boolean }[]> {
    const owned = new Set(
      this.repos.tasks
        .list()
        .filter((task) => task.worktreePath)
        .map((task) => path.resolve(task.worktreePath!)),
    );
    const found: { workspaceId: string; path: string; dirty: boolean }[] = [];
    for (const workspace of this.repos.workspaces.list()) {
      const root = this.options.worktreeRoot(workspace);
      const names = await readdir(root).catch(() => [] as string[]);
      for (const name of names) {
        const target = path.join(root, name);
        if (owned.has(path.resolve(target))) continue;
        if (name.startsWith('check-') || name.startsWith('delivery-')) {
          const info = await stat(target).catch(() => null);
          if (!info || Date.now() - info.mtimeMs < 60 * 60_000) continue;
        }
        // Only a folder that is a worktree itself has changes of its own to keep. A plain or
        // half-created one would make git answer for whatever repository is around it.
        const top = await git(target, ['rev-parse', '--show-toplevel'], {
          allowFailure: true,
          timeoutMs: 30_000,
        }).catch(() => null);
        const own =
          !!top &&
          top.code === 0 &&
          path.resolve(top.stdout.trim()).toLowerCase() === path.resolve(target).toLowerCase();
        const status = own
          ? await git(target, ['status', '--porcelain'], {
              allowFailure: true,
              timeoutMs: 30_000,
            }).catch(() => null)
          : null;
        found.push({
          workspaceId: workspace.id,
          path: target,
          dirty: !!status && status.code === 0 && status.stdout.trim() !== '',
        });
      }
    }
    return found;
  }

  /** Removes the leftover worktrees that hold no uncommitted work; how many were removed. */
  async pruneWorktrees(): Promise<{ removed: number; kept: number }> {
    let removed = 0;
    let kept = 0;
    for (const leftover of await this.leftoverWorktrees()) {
      if (leftover.dirty) {
        kept++;
        continue;
      }
      const workspace = this.repos.workspaces.get(leftover.workspaceId);
      if (!workspace) continue;
      const manager = new WorktreeManager(workspace.path, this.options.worktreeRoot(workspace));
      await manager.remove(leftover.path, null).then(
        () => removed++,
        () => undefined,
      );
    }
    return { removed, kept };
  }

  private async removeLeftoverWorktrees(): Promise<void> {
    await this.pruneWorktrees();
  }

  /** Start (or resume) a run: unfinished tasks are reset and scheduled. */
  start(runId: string): Run {
    const run = this.repos.runs.require(runId, 'Execução');
    if (!RESUMABLE.has(run.status))
      throw new HiveError('CONFLICT', 'Esta missão não pode ser executada agora.');
    // Candidates belong to their task's round: a new try of the task opens a new round.
    const tasks = this.repos.tasks.list('run_id = ?', runId).filter((task) => !task.candidateOf);
    if (!tasks.length) throw new HiveError('VALIDATION', 'Gere um plano antes de executar.');
    const workers = this.repos.workers.list();
    const configured = (worker: Worker | undefined) =>
      !!worker && worker.role !== 'queen' && canRunTasks(worker);
    // The Queen may leave a task unassigned; give it to a configured generalist.
    const fallback =
      workers.find((w) => configured(w) && ['backend', 'frontend', 'architect'].includes(w.role)) ??
      workers.find(configured);
    const problems: string[] = [];
    const assignments = new Map<string, string>();
    for (const task of tasks) {
      if (!['pending', 'blocked', 'failed', 'cancelled'].includes(task.status)) continue;
      const worker = workers.find((item) => item.id === task.workerId);
      if (configured(worker)) continue;
      if (worker && worker.role !== 'queen')
        problems.push(`“${task.title}”: ${worker.name} não tem provedor e modelo.`);
      else if (fallback) assignments.set(task.id, fallback.id);
      else problems.push(`“${task.title}”: nenhum agente configurado para executá-la.`);
    }
    if (problems.length)
      throw new HiveError(
        'VALIDATION',
        `Configure os agentes na aba Agentes antes de executar:\n${problems.join('\n')}`,
      );
    this.repos.transaction(() => {
      for (const task of tasks) {
        const assigned = assignments.get(task.id);
        const reset = NEEDS_RETRY.has(task.status);
        if (reset) this.closeRound(task);
        if (!assigned && !reset) continue;
        this.repos.tasks.put({
          ...task,
          ...(assigned ? { workerId: assigned } : {}),
          ...(reset ? { status: 'pending', workerState: 'idle', error: null } : {}),
        });
      }
    });
    const next = this.repos.runs.put({ ...run, status: 'running', error: null, finishedAt: null });
    this.log(next, null, null, 'run.status', 'info', 'Execução iniciada.');
    this.options.onChange('run', runId);
    this.pump(runId);
    return next;
  }

  cancelRun(runId: string): void {
    const run = this.repos.runs.require(runId, 'Execução');
    this.repos.runs.put({ ...run, status: 'cancelled' });
    for (const task of this.repos.tasks.list('run_id = ?', runId)) this.cancelTask(task.id);
    this.log(run, null, null, 'run.status', 'warn', 'Execução cancelada.');
    this.options.onChange('run', runId);
    this.settle(runId);
  }

  /**
   * Stops every agent session when Hive quits, which kills the commands they started (dev
   * servers, watchers) instead of leaving them running with no owner. Their tasks are left as
   * they are; `recover` saves their work and resumes them at the next start.
   */
  shutdown(): number {
    this.closing = true;
    let stopped = 0;
    for (const [taskId, session] of this.sessions) {
      stopped++;
      void (this.runtimes.get(taskId) ?? this.options.runtime)
        .cancel(session)
        .catch((error: unknown) =>
          console.error(`Não foi possível parar a sessão ${session}:`, error),
        );
    }
    for (const taskId of this.launching) this.cancelRequested.add(taskId);
    return stopped;
  }

  cancelTask(taskId: string): void {
    const task = this.repos.tasks.require(taskId, 'Tarefa');
    this.denyApprovalsOf(taskId);
    // A task running as candidates stops them all; their round ends without a choice.
    const open = this.openCandidates(task);
    if (open.length) {
      for (const candidate of open) {
        this.update(candidate.id, {
          candidateOf: { ...candidate.candidateOf!, outcome: 'lost' },
        });
        this.cancelTask(candidate.id);
      }
      this.update(taskId, {
        status: 'cancelled',
        workerState: 'cancelled',
        error: 'Cancelada.',
        finishedAt: nowIso(),
      });
      return;
    }
    const session = this.sessions.get(taskId);
    if (session) void (this.runtimes.get(taskId) ?? this.options.runtime).cancel(session);
    else if (this.launching.has(taskId)) this.cancelRequested.add(taskId);
    else if (task.status === 'pending' || task.status === 'blocked')
      this.update(taskId, {
        status: 'cancelled',
        workerState: 'cancelled',
        error: 'Cancelada.',
        finishedAt: nowIso(),
      });
  }

  /** Reset a failed, cancelled or rejected task (and tasks skipped because of it) and run it. */
  retry(taskId: string): void {
    const task = this.repos.tasks.require(taskId, 'Tarefa');
    if (task.candidateOf)
      throw new HiveError(
        'CONFLICT',
        'As tentativas são repetidas pela tarefa principal: use Tentar de novo nela.',
      );
    if (!['failed', 'cancelled', 'rejected'].includes(task.status))
      throw new HiveError(
        'CONFLICT',
        'Só é possível repetir tarefas que falharam ou foram canceladas.',
      );
    const reset = (item: Task) =>
      this.update(item.id, {
        status: 'pending',
        workerState: 'idle',
        error: null,
        result: null,
        finishedAt: null,
      });
    this.closeRound(task);
    reset(task);
    // A discarded result is gone, so a retry starts over instead of revising it.
    if (task.status === 'rejected') this.update(task.id, { revision: undefined });
    for (const item of this.repos.tasks.list('run_id = ?', task.runId))
      if (!item.candidateOf && item.status === 'cancelled' && item.error?.startsWith(BLOCKED)) {
        this.closeRound(item);
        reset(item);
      }
    this.resume(task.runId);
  }

  /** A task tried again leaves its last round behind: what is still open there is lost. */
  private closeRound(task: Task): void {
    for (const candidate of this.openCandidates(task))
      this.update(candidate.id, { candidateOf: { ...candidate.candidateOf!, outcome: 'lost' } });
  }

  /**
   * Sends the user's review back to the agent. The task runs again from its own last result,
   * with the comments in its prompt; its diff still covers the whole task.
   */
  revise(taskId: string, comments: ReviewComment[], note: string): void {
    const task = this.repos.tasks.require(taskId, 'Tarefa');
    if (task.status !== 'completed' || !task.result?.commit || !task.startCommit)
      throw new HiveError(
        'CONFLICT',
        'Só tarefas prontas para revisão e com alterações podem receber comentários.',
      );
    if (!comments.length && !note.trim())
      throw new HiveError('VALIDATION', 'Escreva ao menos um comentário para o agente.');
    const round = (task.revision?.round ?? 0) + 1;
    this.update(taskId, {
      status: 'pending',
      workerState: 'idle',
      error: null,
      finishedAt: null,
      revision: {
        fromCommit: task.result.commit,
        startCommit: task.revision?.startCommit ?? task.startCommit,
        round,
        previousSummary: task.result.summary,
        comments,
        note: note.trim(),
      },
    });
    const run = this.repos.runs.require(task.runId, 'Execução');
    this.log(
      run,
      taskId,
      task.workerId,
      'task.status',
      'info',
      `Revisão ${round} enviada ao agente: ${comments.length} comentário(s).`,
    );
    this.resume(task.runId);
  }

  private resume(runId: string): void {
    const run = this.repos.runs.require(runId, 'Execução');
    if (run.status !== 'running') {
      this.repos.runs.put({ ...run, status: 'running', error: null, finishedAt: null });
      this.options.onChange('run', run.id);
    }
    this.pump(runId);
  }

  resolveApproval(approvalId: string, approve: boolean, remember: boolean): void {
    const approval = this.repos.approvals.require(approvalId, 'Aprovação');
    if (approval.status !== 'pending')
      throw new HiveError('CONFLICT', 'Este pedido já foi respondido ou expirou.');
    this.repos.approvals.put({
      ...approval,
      status: approve ? 'approved' : 'denied',
      resolvedAt: nowIso(),
    });
    if (approve && remember && approval.workerId && approval.detail.length <= 200) {
      const worker = this.repos.workers.get(approval.workerId);
      if (worker && !worker.autoApproveCommands.includes(approval.detail))
        this.repos.workers.put({
          ...worker,
          autoApproveCommands: [...worker.autoApproveCommands, approval.detail],
          updatedAt: nowIso(),
        });
    }
    const task = this.repos.tasks.get(approval.taskId);
    if (task?.status === 'waiting_approval')
      this.update(task.id, { status: 'running', workerState: 'thinking' });
    const run = this.repos.runs.get(approval.runId);
    if (run)
      this.log(
        run,
        approval.taskId,
        approval.workerId,
        'approval.resolved',
        'info',
        `${approve ? 'Permitido' : 'Negado'}: ${approval.detail}`,
      );
    this.options.onChange('approval', approvalId);
    const resolve = this.pendingApprovals.get(approvalId);
    this.pendingApprovals.delete(approvalId);
    resolve?.(approve);
  }

  /** Apply a finished task to the user's branch with a merge commit. */
  async approve(taskId: string): Promise<Task> {
    const task = this.repos.tasks.require(taskId, 'Tarefa');
    if (task.status !== 'completed')
      throw new HiveError('CONFLICT', 'Só tarefas concluídas podem ser aplicadas.');
    const run = this.repos.runs.require(task.runId, 'Execução');
    if (task.branch && task.result?.commit) {
      const workspace = this.repos.workspaces.require(run.workspaceId, 'Workspace');
      const repo = await inspectRepository(workspace.path);
      if (repo.branch !== run.baseBranch)
        throw new HiveError(
          'CONFLICT',
          `O repositório está na branch "${repo.branch ?? 'desanexada'}". Volte para "${run.baseBranch}" para aplicar.`,
        );
      const modified = (await statusPorcelain(repo.root)).filter((file) => file.status !== '??');
      if (modified.length)
        throw new HiveError(
          'CONFLICT',
          `Há ${modified.length} arquivo(s) modificados e não commitados no repositório. Faça commit ou descarte essas alterações antes de aplicar.`,
        );
      const email = await git(repo.root, ['config', 'user.email'], { allowFailure: true });
      const identity = email.code === 0 && email.stdout.trim() ? [] : hiveCommitFlags;
      const merged = await git(
        repo.root,
        [...identity, 'merge', '--no-ff', '--no-edit', '-m', `hive: ${task.title}`, task.branch],
        { allowFailure: true },
      );
      if (merged.code !== 0) {
        await git(repo.root, ['merge', '--abort'], { allowFailure: true });
        throw new HiveError(
          'CONFLICT',
          `Conflito ao aplicar "${task.title}". Nada foi alterado. ${(merged.stdout || merged.stderr).trim().slice(0, 400)}`,
        );
      }
      this.log(run, task.id, task.workerId, 'git', 'info', `Aplicado em ${run.baseBranch}.`, {
        action: 'merged',
        branch: run.baseBranch,
        commit: task.result.commit,
      });
    }
    const updated = this.update(taskId, { status: 'approved', workerState: 'completed' });
    this.settle(run.id);
    return updated;
  }

  async reject(taskId: string): Promise<Task> {
    const task = this.repos.tasks.require(taskId, 'Tarefa');
    if (task.status !== 'completed')
      throw new HiveError('CONFLICT', 'Só tarefas concluídas podem ser descartadas.');
    const run = this.repos.runs.require(task.runId, 'Execução');
    const workspace = this.repos.workspaces.require(run.workspaceId, 'Workspace');
    // Only Hive's own task branches are ever deleted here, whatever the task record says.
    if (task.branch && isHiveBranch(task.branch))
      await git(workspace.path, ['branch', '-D', '--', task.branch], { allowFailure: true });
    const updated = this.update(taskId, { status: 'rejected', workerState: 'failed' });
    this.log(run, task.id, task.workerId, 'git', 'info', 'Alterações descartadas.');
    this.settle(run.id);
    return updated;
  }

  async diff(taskId: string): Promise<{ base: string; result: DiffResult | null }> {
    const task = this.repos.tasks.require(taskId, 'Tarefa');
    if (!task.startCommit || !task.result?.commit)
      return { base: task.startCommit ?? '', result: null };
    const run = this.repos.runs.require(task.runId, 'Execução');
    const workspace = this.repos.workspaces.require(run.workspaceId, 'Workspace');
    return {
      base: task.startCommit,
      result: await diffRefs(workspace.path, task.startCommit, task.result.commit),
    };
  }

  /**
   * Gives a task honey, or takes it back. Only while it waits (or can be retried): honey
   * changes how a task is started, not one already under way.
   */
  boost(taskId: string, boosted: boolean): Task {
    const task = this.repos.tasks.require(taskId, 'Tarefa');
    const waiting = ['pending', 'blocked', 'failed', 'cancelled', 'rejected'].includes(task.status);
    if (!waiting || this.sessions.has(taskId) || this.launching.has(taskId))
      throw new HiveError(
        'CONFLICT',
        'O mel só vale para tarefas que ainda não começaram ou que vão ser tentadas de novo.',
      );
    const updated = this.update(taskId, { boosted });
    this.pump(task.runId);
    return updated;
  }

  /* ---------------------------------------------------------------- several attempts */

  /**
   * Makes a task run as `count` attempts in parallel, each on a different model, keeping the best
   * result; null makes it run once again. Like honey, only before it starts (or is tried again).
   */
  setBestOf(taskId: string, count: number | null): Task {
    const task = this.repos.tasks.require(taskId, 'Tarefa');
    if (task.candidateOf || task.team)
      throw new HiveError(
        'VALIDATION',
        'Várias tentativas valem para tarefas comuns, não para tarefas de equipe nem para uma tentativa.',
      );
    const waiting = ['pending', 'blocked', 'failed', 'cancelled', 'rejected'].includes(task.status);
    if (!waiting || this.sessions.has(taskId) || this.launching.has(taskId))
      throw new HiveError(
        'CONFLICT',
        'Várias tentativas só valem para tarefas que ainda não começaram ou que vão ser tentadas de novo.',
      );
    if (count !== null && (!Number.isInteger(count) || count < 2 || count > MAX_TASK_CANDIDATES))
      throw new HiveError('VALIDATION', `Escolha de 2 a ${MAX_TASK_CANDIDATES} tentativas.`);
    return this.update(taskId, {
      bestOf: count === null ? undefined : { count, choice: task.bestOf?.choice ?? null },
    });
  }

  private wantsCandidates(task: Task): boolean {
    return (
      !!task.bestOf &&
      !task.candidateOf &&
      // A revision goes back to the result that won, and a team has its own way of working.
      !task.revision &&
      !task.team &&
      !this.singleAttempt.has(`${task.id}:${task.attempt}`)
    );
  }

  private candidatesOf(task: Task): Task[] {
    return this.repos.tasks
      .list('run_id = ?', task.runId)
      .filter((item) => item.candidateOf?.parentTaskId === task.id);
  }

  /** Candidates of the task's current round that were not decided yet. */
  private openCandidates(task: Task): Task[] {
    if (!task.bestOf || task.candidateOf) return [];
    return this.candidatesOf(task).filter(
      (item) => item.candidateOf!.round === task.attempt && !item.candidateOf!.outcome,
    );
  }

  /** The model of the candidate that won the task's last round. */
  private winningModel(task: Task): CandidateModel | null {
    const choice = task.bestOf?.choice;
    const score = choice?.scores.find((item) => item.taskId === choice.winnerTaskId);
    return score ? { providerId: score.providerId, modelId: score.modelId } : null;
  }

  /**
   * Starts a round: one candidate per model, and the task waits for them. False when the task
   * runs once instead (fewer than two models), which is then launched as usual.
   */
  private openRound(run: Run, parent: Task): boolean {
    // After a restart, the round that was going is picked up, not started over.
    if (this.openCandidates(parent).length) {
      this.update(parent.id, {
        status: 'running',
        workerState: 'thinking',
        error: null,
        finishedAt: null,
      });
      return true;
    }
    const worker = parent.workerId ? this.repos.workers.get(parent.workerId) : null;
    if (!worker || !canRunTasks(worker)) return false;
    const count = parent.bestOf!.count;
    let models: CandidateModel[] = [];
    try {
      models = this.options.candidateModels?.(worker, count) ?? [];
    } catch (error) {
      this.log(run, parent.id, worker.id, 'info', 'warn', errorMessage(error));
    }
    const unique = models
      .filter(
        (model, index) =>
          models.findIndex(
            (other) => other.providerId === model.providerId && other.modelId === model.modelId,
          ) === index,
      )
      .slice(0, count);
    if (unique.length < 2) {
      this.singleAttempt.add(`${parent.id}:${parent.attempt}`);
      this.log(
        run,
        parent.id,
        worker.id,
        'task.status',
        'warn',
        'Várias tentativas pedidas, mas só há um modelo grátis disponível para este agente agora: a tarefa roda uma vez.',
      );
      return false;
    }
    const round = parent.attempt + 1;
    const at = nowIso();
    const created: Task[] = [];
    this.repos.transaction(() => {
      unique.forEach((model, index) =>
        created.push(
          this.repos.tasks.put({
            ...newCandidate(parent, newId('task'), round, index + 1, model, at),
            // The error of the try that failed reaches every candidate of the next one.
            ...(parent.retryNote ? { retryNote: parent.retryNote } : {}),
          }),
        ),
      );
      this.update(parent.id, {
        status: 'running',
        workerState: 'thinking',
        attempt: round,
        error: null,
        result: null,
        retryNote: undefined,
        startedAt: at,
        finishedAt: null,
        bestOf: { ...parent.bestOf!, choice: null },
      });
    });
    for (const candidate of created) this.options.onChange('task', candidate.id);
    this.log(
      run,
      parent.id,
      worker.id,
      'task.status',
      'info',
      `${unique.length} tentativas em paralelo, cada uma com um modelo: ${unique.map((model) => model.modelId).join(', ')}.`,
    );
    return true;
  }

  /** Decides the task's round once all its candidates have ended. */
  private maybeChoose(run: Run, parent: Task): void {
    if (this.choosing.has(parent.id) || this.closing) return;
    // Running once (for lack of models): an ordinary attempt, nothing to choose.
    if (this.sessions.has(parent.id) || this.launching.has(parent.id)) return;
    const open = this.openCandidates(parent);
    if (!open.length) {
      this.update(parent.id, {
        status: 'failed',
        workerState: 'failed',
        error: 'As tentativas desta tarefa não existem mais. Tente de novo.',
        finishedAt: nowIso(),
      });
      return;
    }
    if (
      open.some((task) => !['completed', 'failed', 'cancelled', 'rejected'].includes(task.status))
    )
      return;
    this.choosing.add(parent.id);
    void this.choose(run, parent, open).finally(() => {
      this.choosing.delete(parent.id);
      if (!this.closing) {
        this.pumpAll();
        this.settle(run.id);
      }
    });
  }

  /**
   * Compares a round: the project's checks on each candidate that changed something, then the
   * best one becomes the task's result. The others' branches are deleted. With no candidate that
   * succeeded, the task fails (or, unattended, gets another round).
   */
  private async choose(run: Run, parent: Task, round: Task[]): Promise<void> {
    try {
      this.update(parent.id, { workerState: 'testing' });
      const scores: CandidateScore[] = [];
      for (const task of round) {
        let checks: CandidateCheck[] = [];
        if (task.status === 'completed' && task.result?.commit && this.options.checkCandidate)
          try {
            checks = await this.options.checkCandidate({ run, task });
          } catch (error) {
            this.log(
              run,
              parent.id,
              parent.workerId,
              'info',
              'warn',
              `As verificações da tentativa ${task.candidateOf!.number} não rodaram: ${errorMessage(error)}`,
            );
          }
        scores.push({
          taskId: task.id,
          number: task.candidateOf!.number,
          providerId: task.candidateOf!.providerId,
          modelId: task.candidateOf!.modelId,
          status: task.status,
          checks,
        });
      }
      if (this.closing) return;
      const current = this.repos.tasks.get(parent.id);
      // Cancelled (or tried again) while the checks ran: this round is no longer the task's.
      if (current?.status !== 'running' || current.attempt !== parent.attempt) return;
      const decided = round.map((task) => this.repos.tasks.require(task.id, 'Tarefa'));
      const { winner, reason } = pickWinner(decided, scores);
      const choice = { round: parent.attempt, winnerTaskId: winner?.id ?? null, reason, scores };
      const workspace = this.repos.workspaces.require(run.workspaceId, 'Workspace');
      for (const task of decided) {
        const won = task.id === winner?.id;
        this.update(task.id, {
          candidateOf: { ...task.candidateOf!, outcome: won ? 'won' : 'lost' },
        });
        if (!won && task.branch && isHiveBranch(task.branch))
          await git(workspace.path, ['branch', '-D', '--', task.branch], { allowFailure: true });
      }
      if (winner) {
        this.update(parent.id, {
          status: 'completed',
          workerState: 'completed',
          result: winner.result,
          branch: winner.branch,
          startCommit: winner.startCommit,
          error: null,
          finishedAt: nowIso(),
          bestOf: { ...current.bestOf!, choice },
        });
        this.log(run, parent.id, parent.workerId, 'task.status', 'info', `Escolhida. ${reason}`);
        return;
      }
      const error = failureSummary(decided);
      this.update(parent.id, { bestOf: { ...current.bestOf!, choice } });
      if (this.retryUnattended(run, parent.id, parent.attempt, error)) return;
      this.update(parent.id, {
        status: 'failed',
        workerState: 'failed',
        error,
        finishedAt: nowIso(),
      });
      this.log(run, parent.id, parent.workerId, 'task.status', 'warn', error);
      this.failedForGood(run, parent.id);
    } catch (error) {
      if (this.closing) return;
      const message = `Não foi possível comparar as tentativas: ${errorMessage(error)}`;
      this.update(parent.id, {
        status: 'failed',
        workerState: 'failed',
        error: message,
        finishedAt: nowIso(),
      });
      this.log(run, parent.id, parent.workerId, 'error', 'error', message);
    }
  }

  /* ---------------------------------------------------------------- changes by hand */

  /**
   * Adds a task to a run's plan, with the same rules as the Queen's: a unique key, known
   * dependencies, no cycle, and an agent that can do the work. While the run is going it is
   * picked up as soon as its dependencies are done; otherwise it waits for the next start.
   */
  /**
   * Adds a task to a run. `extra` carries what a plan task does not: where the task came from
   * (Hive Teams sets the parent task and the task's place in a team).
   */
  addTask(runId: string, input: PlanTask, extra: Pick<Task, 'parentTaskId' | 'team'> = {}): Task {
    const run = this.repos.runs.require(runId, 'Execução');
    if (!EDITABLE.has(run.status))
      throw new HiveError('CONFLICT', 'Gere o plano antes de adicionar tarefas a esta missão.');
    const { lead, ...plan } = planTaskSchema.parse(input);
    const tasks = this.repos.tasks.list('run_id = ?', runId);
    // Candidates are attempts of a task, not more work: they do not count towards the limit.
    if (tasks.filter((task) => !task.candidateOf).length >= MAX_RUN_TASKS)
      throw new HiveError('VALIDATION', `Uma missão tem no máximo ${MAX_RUN_TASKS} tarefas.`);
    if (tasks.some((task) => task.key === plan.key))
      throw new HiveError('CONFLICT', `Já existe uma tarefa com a chave "${plan.key}".`);
    for (const dep of plan.dependsOn)
      if (!tasks.some((task) => task.key === dep))
        throw new HiveError('VALIDATION', `Dependência desconhecida: "${dep}".`);
    if (plan.workerId) this.requireWorker(plan.workerId);
    const id = newId('task');
    const task = this.repos.tasks.put({
      ...plan,
      ...extra,
      // A plan task marked as a lead starts a Hive Teams team of its own.
      ...(lead && !extra.team
        ? { team: { role: 'lead' as const, leadTaskId: id, requestId: null } }
        : {}),
      id,
      runId,
      status: 'pending',
      workerState: 'idle',
      attempt: 0,
      branch: null,
      startCommit: null,
      worktreePath: null,
      result: null,
      error: null,
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
    });
    this.log(run, task.id, task.workerId, 'plan', 'info', `Tarefa adicionada: ${task.title}.`);
    this.options.onChange('task', task.id);
    this.pump(runId);
    return task;
  }

  /** Makes `taskId` wait for (or stop waiting for) another task of the same run. */
  setDependency(taskId: string, dependsOnTaskId: string, linked: boolean): Task {
    const task = this.notStarted(taskId, 'mudar as dependências');
    const dependency = this.repos.tasks.require(dependsOnTaskId, 'Tarefa');
    if (dependency.runId !== task.runId || dependency.id === task.id)
      throw new HiveError('VALIDATION', 'A dependência precisa ser outra tarefa da mesma missão.');
    const others = task.dependsOn.filter((key) => key !== dependency.key);
    const dependsOn = linked ? [...others, dependency.key] : others;
    if (dependsOn.length > 10)
      throw new HiveError('VALIDATION', 'Uma tarefa depende de no máximo 10 outras.');
    const tasks = this.repos.tasks
      .list('run_id = ?', task.runId)
      .map((item) => (item.id === task.id ? { ...item, dependsOn } : item));
    const cycle = findCycle(tasks);
    if (cycle) throw new HiveError('VALIDATION', `Isso criaria um ciclo: ${cycle.join(' → ')}.`);
    const updated = this.update(task.id, { dependsOn });
    const run = this.repos.runs.require(task.runId, 'Execução');
    this.log(
      run,
      task.id,
      task.workerId,
      'plan',
      'info',
      linked
        ? `${task.title} agora depende de ${dependency.title}.`
        : `${task.title} não depende mais de ${dependency.title}.`,
    );
    this.pump(task.runId);
    return updated;
  }

  /** Hands a task that has not started (or will be tried again) to another agent. */
  assign(taskId: string, workerId: string): Task {
    const task = this.repos.tasks.require(taskId, 'Tarefa');
    const open = NOT_STARTED.has(task.status) || NEEDS_RETRY.has(task.status);
    if (!open || this.sessions.has(taskId) || this.launching.has(taskId))
      throw new HiveError(
        'CONFLICT',
        'Só dá para delegar uma tarefa que ainda não começou ou que vai ser tentada de novo.',
      );
    const worker = this.requireWorker(workerId);
    const updated = this.update(task.id, { workerId: worker.id });
    const run = this.repos.runs.require(task.runId, 'Execução');
    this.log(run, task.id, worker.id, 'plan', 'info', `${task.title} delegada a ${worker.name}.`);
    return updated;
  }

  private notStarted(taskId: string, what: string): Task {
    const task = this.repos.tasks.require(taskId, 'Tarefa');
    if (!NOT_STARTED.has(task.status) || this.sessions.has(taskId) || this.launching.has(taskId))
      throw new HiveError('CONFLICT', `Só dá para ${what} de uma tarefa que ainda não começou.`);
    if (!EDITABLE.has(this.repos.runs.require(task.runId, 'Execução').status))
      throw new HiveError('CONFLICT', 'Esta missão não aceita mudanças agora.');
    return task;
  }

  /** An agent that can execute tasks: not the Queen, with a provider and a model. */
  private requireWorker(workerId: string): Worker {
    const worker = this.repos.workers.require(workerId, 'Agente');
    if (worker.role === 'queen')
      throw new HiveError('VALIDATION', 'A Queen planeja; tarefas vão para os outros agentes.');
    if (!canRunTasks(worker))
      throw new HiveError('VALIDATION', `${worker.name} ainda não tem provedor e modelo.`);
    return worker;
  }

  /**
   * Adaptive replanning: sets a failed task aside and makes the tasks that waited on it wait on
   * `replacementKeys` instead (none to let them go on without it). Only tasks that have not
   * started change; the failed task becomes "Descartada" with `note` as the reason.
   */
  reroute(taskId: string, replacementKeys: string[], note: string): void {
    const failed = this.repos.tasks.require(taskId, 'Tarefa');
    if (failed.status !== 'failed')
      throw new HiveError('CONFLICT', 'A tarefa não está mais falha; nada foi alterado.');
    const run = this.repos.runs.require(failed.runId, 'Execução');
    if (run.status !== 'running')
      throw new HiveError('CONFLICT', 'A missão não está mais em execução.');
    const tasks = this.repos.tasks.list('run_id = ?', failed.runId);
    const keys = new Set(tasks.map((task) => task.key));
    for (const key of replacementKeys)
      if (!keys.has(key) || key === failed.key)
        throw new HiveError('VALIDATION', `Tarefa de continuação desconhecida: "${key}".`);
    const dependents = tasks.filter(
      (task) => task.dependsOn.includes(failed.key) && NOT_STARTED.has(task.status),
    );
    const changes = new Map<string, string[]>();
    for (const task of dependents) {
      if (this.sessions.has(task.id) || this.launching.has(task.id))
        throw new HiveError('CONFLICT', `${task.title} já começou; nada foi alterado.`);
      const dependsOn = [
        ...new Set([...task.dependsOn.filter((key) => key !== failed.key), ...replacementKeys]),
      ];
      if (dependsOn.length > 10)
        throw new HiveError(
          'VALIDATION',
          `${task.title} passaria a depender de mais de 10 tarefas.`,
        );
      changes.set(task.id, dependsOn);
    }
    const cycle = findCycle(
      tasks.map((task) => ({ ...task, dependsOn: changes.get(task.id) ?? task.dependsOn })),
    );
    if (cycle) throw new HiveError('VALIDATION', `Isso criaria um ciclo: ${cycle.join(' → ')}.`);
    this.repos.transaction(() => {
      for (const [id, dependsOn] of changes) this.update(id, { dependsOn });
      this.update(failed.id, {
        status: 'rejected',
        workerState: 'failed',
        error: note.slice(0, 2_000),
        finishedAt: failed.finishedAt ?? nowIso(),
      });
    });
    this.log(run, failed.id, failed.workerId, 'plan', 'info', note);
    this.pump(failed.runId);
  }

  /** Looks at a run again: after a replanning decision, held tasks may go on or be cancelled. */
  refresh(runId: string): void {
    this.pump(runId);
    this.settle(runId);
  }

  private held(task: Task): boolean {
    if (task.status !== 'failed' || !this.options.holds) return false;
    try {
      return this.options.holds(task);
    } catch {
      return false;
    }
  }

  /** Every dependency that ended without success is a failed task held for replanning. */
  private waitsOnHold(task: Task, tasks: Task[]): boolean {
    const byKey = new Map(tasks.map((item) => [item.key, item]));
    const bad = task.dependsOn
      .map((key) => byKey.get(key))
      .filter((dep) => !dep || ['failed', 'cancelled', 'rejected'].includes(dep.status));
    return bad.length > 0 && bad.every((dep) => !!dep && this.held(dep));
  }

  /** Lets a replanning listener know, without ever breaking the scheduler. */
  private failedForGood(run: Run, taskId: string): void {
    if (!this.options.onTaskFailed) return;
    const task = this.repos.tasks.get(taskId);
    // A candidate failing is not the task failing: the others may still succeed.
    if (task?.status !== 'failed' || task.candidateOf) return;
    try {
      this.options.onTaskFailed(run, task);
    } catch (error) {
      this.log(
        run,
        taskId,
        task.workerId,
        'info',
        'warn',
        `Replanejamento indisponível: ${errorMessage(error)}`,
      );
    }
  }

  isActive(runId: string): boolean {
    return this.repos.tasks
      .list('run_id = ?', runId)
      .some(
        (task) =>
          this.sessions.has(task.id) || this.launching.has(task.id) || this.choosing.has(task.id),
      );
  }

  /* ---------------------------------------------------------------- internals */

  private pumpAll(): void {
    for (const run of this.repos.runs.list()) if (run.status === 'running') this.pump(run.id);
  }

  private pump(runId: string): void {
    if (this.closing || this.recovering) return;
    const run = this.repos.runs.get(runId);
    if (!run || run.status !== 'running') return;
    let tasks = this.repos.tasks.list('run_id = ?', runId);
    // Until nothing changes: a task cancelled here blocks the ones that wait on it in turn.
    for (let changed = true; changed;) {
      changed = false;
      for (const task of tasks) {
        if (
          (task.status === 'pending' || task.status === 'blocked') &&
          isBlockedByFailure(task, tasks) &&
          !this.waitsOnHold(task, tasks)
        ) {
          this.update(task.id, {
            status: 'cancelled',
            workerState: 'cancelled',
            error: `${BLOCKED}: ${task.dependsOn.join(', ')}.`,
            finishedAt: nowIso(),
          });
          changed = true;
        }
      }
      tasks = this.repos.tasks.list('run_id = ?', runId);
    }
    // A task marked for several attempts opens a round of candidates instead of starting itself.
    let opened = false;
    for (const task of readyTasks(tasks))
      if (this.wantsCandidates(task) && this.openRound(run, task)) opened = true;
    if (opened) tasks = this.repos.tasks.list('run_id = ?', runId);
    // A round whose candidates all ended is decided.
    for (const task of tasks)
      if (task.bestOf && !task.candidateOf && task.status === 'running')
        this.maybeChoose(run, task);
    const limit = this.repos.getSettings().maxConcurrentTasks;
    // Tasks given honey go first, and may take one slot over the limit so they never wait.
    const ready = readyTasks(tasks).sort((a, b) => Number(!!b.boosted) - Number(!!a.boosted));
    for (const task of ready) {
      const busy = this.sessions.size + this.launching.size;
      if (busy >= limit + (task.boosted ? 1 : 0)) {
        if (task.boosted) continue;
        break;
      }
      if (this.launching.has(task.id) || this.sessions.has(task.id)) continue;
      this.launching.add(task.id);
      void this.launch(run, task);
    }
    this.settle(runId);
  }

  /** Decide the run status once nothing is running or ready any more. */
  private settle(runId: string): void {
    const run = this.repos.runs.get(runId);
    if (!run) return;
    const all = this.repos.tasks.list('run_id = ?', runId);
    const busy = all.some(
      (task) =>
        activeStatuses.has(task.status) ||
        this.launching.has(task.id) ||
        this.sessions.has(task.id) ||
        this.choosing.has(task.id),
    );
    if (busy || (run.status === 'running' && readyTasks(all).length)) return;
    // Candidates are attempts of a task: the task they belong to speaks for them.
    const tasks = all.filter((task) => !task.candidateOf);
    if (run.status === 'running' && tasks.some((task) => task.status === 'pending')) return;
    // A failed task waiting for a replanning decision keeps the run open, even as a leaf.
    if (run.status === 'running' && tasks.some((task) => this.held(task))) return;
    const failed = tasks.filter((task) => task.status === 'failed').length;
    const status: RunStatus =
      run.status === 'cancelled'
        ? 'cancelled'
        : tasks.some((task) => task.status === 'completed')
          ? 'review'
          : failed
            ? 'failed'
            : 'completed';
    const mission = this.repos.missions.get(run.missionId);
    const next: Run = {
      ...run,
      status,
      error: status === 'failed' ? `${failed} tarefa(s) falharam.` : null,
      finishedAt: run.finishedAt ?? nowIso(),
      report: mission ? buildRunReport(mission, run, tasks, this.repos.workers.list()) : run.report,
    };
    if (next.status === run.status && next.report === run.report && next.error === run.error)
      return;
    this.repos.runs.put(next);
    if (next.status !== run.status)
      this.log(next, null, null, 'run.status', 'info', `Execução: ${status}.`);
    this.options.onChange('run', runId);
  }

  private async launch(run: Run, initial: Task): Promise<void> {
    const attempt = initial.attempt + 1;
    const sessionId = `${initial.id}-a${attempt}`;
    const workspace = this.repos.workspaces.require(run.workspaceId, 'Workspace');
    const manager = new WorktreeManager(workspace.path, this.options.worktreeRoot(workspace));
    const branch = taskBranchName(run.id, initial.key, attempt);
    let worktree: string | null = null;
    let commit: string | null = null;
    // A revision continues from the task's last result, which already holds its dependencies.
    const revision = initial.revision;
    const previousBranch = revision ? initial.branch : null;
    // An attempt Hive's closing cut off is continued from what it had done, not started over.
    const checkpoint = initial.checkpoint?.commit ? initial.checkpoint : null;
    const checkCancelled = () => {
      if (this.cancelRequested.delete(initial.id))
        throw new HiveError('CANCELLED', 'Cancelada antes de começar.');
    };
    try {
      const agent = this.repos.workers.require(initial.workerId ?? '', 'Agente');
      // A candidate runs on its own model; a revision of a task with several attempts, on the
      // model that won, which wrote the result being revised.
      const model = initial.candidateOf ?? (initial.revision ? this.winningModel(initial) : null);
      const assigned = model
        ? { ...agent, providerId: model.providerId, modelId: model.modelId }
        : agent;
      const worker = initial.boosted ? honeyBoost(assigned) : assigned;
      if (!canRunTasks(worker))
        throw new HiveError('VALIDATION', `${worker.name} não tem provedor e modelo configurados.`);
      this.update(initial.id, {
        status: 'running',
        workerState: 'planning',
        attempt,
        branch,
        error: null,
        result: null,
        retryNote: undefined,
        startedAt: nowIso(),
        finishedAt: null,
      });
      this.log(
        run,
        initial.id,
        worker.id,
        'task.status',
        'info',
        initial.boosted
          ? `${worker.name} começou com mel: limites dobrados e esquadrão completo.`
          : `${worker.name} começou.`,
      );
      const name = `${run.id.slice(-6)}-${initial.key}-a${attempt}`.replace(/[^\w-]+/g, '-');
      worktree = await manager.create(
        name,
        branch,
        checkpoint?.commit ?? revision?.fromCommit ?? run.baseCommit,
      );
      const tasks = this.repos.tasks.list('run_id = ?', run.id);
      const upstream = initial.dependsOn
        .map((key) => tasks.find((task) => task.key === key))
        .filter((task): task is Task => !!task);
      // A checkpoint already holds the dependencies merged by the attempt it came from.
      if (!revision && !checkpoint)
        for (const dependency of integrationSources(upstream, tasks)) {
          await manager.mergeBranch(worktree, dependency.result!.commit!);
          this.log(run, initial.id, worker.id, 'git', 'debug', `Incluído: ${dependency.title}`);
        }
      const startCommit =
        checkpoint?.startCommit ??
        revision?.startCommit ??
        (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim();
      this.update(initial.id, { worktreePath: worktree, startCommit, workerState: 'thinking' });
      const { skills, missing } = await this.options.resolveSkills(worker.skills);
      if (missing.length)
        this.log(
          run,
          initial.id,
          worker.id,
          'info',
          'warn',
          `Skills ausentes: ${missing.join(', ')}`,
        );
      checkCancelled();

      let memory: AgentMemory | undefined;
      if (this.options.prepareMemory)
        try {
          const prepared = await this.options.prepareMemory({ run, task: initial, worker });
          if (prepared) {
            memory = prepared.memory;
            this.log(run, initial.id, worker.id, 'memory', 'info', prepared.summary);
          }
        } catch (error) {
          this.log(
            run,
            initial.id,
            worker.id,
            'memory',
            'warn',
            `Nectar indisponível para esta tarefa; seguindo sem memória compartilhada: ${errorMessage(error)}`,
          );
        }
      if (this.options.teamTools) {
        const team = this.options.teamTools({
          run,
          task: this.repos.tasks.require(initial.id, 'Tarefa'),
          worker,
        });
        if (team) memory = memory ? mergeMemory(memory, team) : team;
      }
      checkCancelled();

      const previousError = initial.retryNote;
      const notes = [
        initial.description,
        checkpoint
          ? `Esta tarefa já tinha começado e foi interrompida porque o Hive fechou. O que a tentativa anterior fez já está nesta pasta (veja com \`git diff ${startCommit.slice(0, 12)}\`). Confira o estado atual, não refaça o que está pronto e termine o que falta.`
          : null,
        previousError
          ? `A tentativa anterior falhou com este erro: ${previousError}\nCorrija a causa antes de concluir.`
          : null,
      ];
      const runtime = this.options.runtimeFor?.(worker) ?? this.options.runtime;
      this.runtimes.set(initial.id, runtime);
      const session = await runtime.start({
        sessionId,
        task: {
          title: initial.title,
          description: notes.filter(Boolean).join('\n\n'),
          acceptanceCriteria: initial.acceptanceCriteria,
          upstream: upstream.map((task) => ({
            title: task.title,
            summary: task.result?.summary ?? '',
          })),
          ...(revision
            ? {
                review: {
                  round: revision.round,
                  previousSummary: revision.previousSummary,
                  comments: revision.comments,
                  note: revision.note,
                },
              }
            : {}),
        },
        worker,
        model: worker.modelId!,
        chat: this.options.chatForWorker
          ? this.options.chatForWorker(worker, (message, data) =>
              this.log(run, initial.id, worker.id, 'info', 'warn', message, data),
            )
          : this.options.chatFor(worker.providerId!),
        worktreePath: worktree,
        skills,
        limits: worker.limits,
        ...(memory ? { memory } : {}),
        requestApproval: ({ command }) => this.requestApproval(run, initial.id, worker, command),
      });
      this.sessions.set(initial.id, sessionId);
      this.launching.delete(initial.id);
      const unsubscribe = runtime.subscribe(sessionId, (event) =>
        this.onRuntimeEvent(run, initial.id, worker.id, event),
      );
      if (this.cancelRequested.delete(initial.id)) void runtime.cancel(sessionId);
      const outcome = await session.done;
      unsubscribe();
      // Hive is quitting: the attempt stays as it is, for the next start to save and resume.
      if (this.closing) return;

      commit = await manager.commitAll(
        worktree,
        revision ? `hive: ${initial.title} (revisão ${revision.round})` : `hive: ${initial.title}`,
      );
      // An attempt that changed nothing still holds the earlier work, so it stays reviewable.
      commit ??= checkpoint?.commit ?? revision?.fromCommit ?? null;
      const diff = commit ? await diffRefs(worktree, startCommit, commit) : null;
      const result: TaskResult = {
        summary: outcome.summary,
        filesChanged: diff?.files.map((file) => ({ path: file.path, status: file.status })) ?? [],
        insertions: diff?.insertions ?? 0,
        deletions: diff?.deletions ?? 0,
        commit,
        commands: outcome.commands,
        usage: outcome.usage,
        ...(outcome.metrics ? { metrics: outcome.metrics } : {}),
      };
      if (
        outcome.status === 'failed' &&
        this.retryUnattended(run, initial.id, attempt, outcome.error)
      )
        return;
      this.update(initial.id, {
        status: outcome.status,
        workerState: stateForTaskStatus(outcome.status) ?? 'idle',
        result,
        error: outcome.error,
        finishedAt: nowIso(),
        worktreePath: null,
        // The attempt ran to its end: its result now holds the interrupted work too.
        checkpoint: undefined,
      });
      if (checkpoint?.branch && checkpoint.branch !== branch && isHiveBranch(checkpoint.branch))
        await git(workspace.path, ['branch', '-D', '--', checkpoint.branch], {
          allowFailure: true,
        });
      this.log(
        run,
        initial.id,
        worker.id,
        'task.status',
        outcome.status === 'completed' ? 'info' : 'warn',
        outcome.status === 'completed'
          ? `Concluída: ${result.filesChanged.length} arquivo(s), +${result.insertions} −${result.deletions}.`
          : `${outcome.status === 'cancelled' ? 'Cancelada' : 'Falhou'}: ${outcome.error ?? ''}`,
      );
      if (outcome.status === 'failed') this.failedForGood(run, initial.id);
      // The revised branch holds the earlier work too, so the old branch is no longer needed.
      if (previousBranch && previousBranch !== branch && outcome.status === 'completed')
        await git(workspace.path, ['branch', '-D', previousBranch], { allowFailure: true });
    } catch (error) {
      // Hive is quitting: whatever broke here broke because of that; `recover` sorts it out.
      if (this.closing) return;
      const cancelled = error instanceof HiveError && error.code === 'CANCELLED';
      const message = secretRedactor.redact(clipText(errorMessage(error)));
      if (!cancelled && this.retryUnattended(run, initial.id, attempt, message)) return;
      this.update(initial.id, {
        status: cancelled ? 'cancelled' : 'failed',
        workerState: cancelled ? 'cancelled' : 'failed',
        error: message,
        finishedAt: nowIso(),
        worktreePath: null,
      });
      this.log(run, initial.id, initial.workerId, 'error', cancelled ? 'warn' : 'error', message);
      if (!cancelled) this.failedForGood(run, initial.id);
    } finally {
      // The attempt counts as going until its cleanup is done: otherwise the run could be closed
      // (and the next task picked) while its worktree is still being removed.
      const release = () => {
        this.launching.delete(initial.id);
        this.sessions.delete(initial.id);
        this.runtimes.delete(initial.id);
        this.cancelRequested.delete(initial.id);
      };
      // While quitting, the worktree and the records stay for `recover` to save at the next start.
      if (this.closing) release();
      else {
        try {
          this.denyApprovalsOf(initial.id);
          // The branch is kept only when it holds work to review.
          if (worktree)
            await manager.remove(worktree, commit ? null : branch).catch(() => undefined);
          // An attempt sent back to the queue (an unattended retry) has not ended yet.
          const ended = this.repos.tasks.get(initial.id);
          // A candidate's end is its task's business: the round decides when all have ended.
          if (
            ended &&
            !ended.candidateOf &&
            ['completed', 'failed', 'cancelled'].includes(ended.status)
          )
            try {
              this.options.onTaskFinished?.(run, ended);
            } catch (error) {
              this.log(run, initial.id, ended.workerId, 'error', 'warn', errorMessage(error));
            }
        } finally {
          release();
        }
        this.pumpAll();
        this.settle(run.id);
      }
    }
  }

  /** While unattended, a failed attempt goes back to the queue with its error, up to the limit. */
  private retryUnattended(
    run: Run,
    taskId: string,
    attempt: number,
    error: string | null,
  ): boolean {
    if (!this.options.unattended?.(run.id)) return false;
    // Git missing or the project folder broken: another attempt would fail the same way.
    if (isEnvironmentFailure(error)) return false;
    const max = this.repos.getSettings().autopilot.maxAttempts;
    if (attempt >= max || this.repos.runs.get(run.id)?.status !== 'running') return false;
    const reason = error?.trim() || 'erro sem descrição';
    this.update(taskId, {
      retryNote: reason.slice(0, 2_000),
      status: 'pending',
      workerState: 'idle',
      error: null,
      result: null,
      finishedAt: null,
      worktreePath: null,
    });
    const workerId = this.repos.tasks.get(taskId)?.workerId ?? null;
    this.log(
      run,
      taskId,
      workerId,
      'task.status',
      'warn',
      `Nova tentativa automática (${attempt + 1} de ${max}): ${reason}`,
    );
    return true;
  }

  private requestApproval(
    run: Run,
    taskId: string,
    worker: Worker,
    command: string,
  ): Promise<boolean> {
    const settings = this.repos.getSettings();
    // The approval setting lets read-only commands (or every command) through without asking.
    // Checks like `npm test` are not read-only: they run project scripts the agent may have edited.
    if (
      settings.commandApproval === 'all' ||
      (settings.commandApproval === 'safe' && isSafeCommand(command))
    ) {
      this.log(
        run,
        taskId,
        worker.id,
        'approval.resolved',
        'info',
        `Liberado automaticamente (${settings.commandApproval === 'all' ? 'todos os comandos' : 'comando seguro'}): ${command}`,
      );
      return Promise.resolve(true);
    }
    // Nobody is there to answer: the safe list decides at once and the decision is logged.
    if (this.options.unattended?.(run.id)) {
      const allowed = shiftAllows(command, settings.autopilot);
      this.log(
        run,
        taskId,
        worker.id,
        'approval.resolved',
        allowed ? 'info' : 'warn',
        `${allowed ? 'Liberado' : 'Negado'} automaticamente (Modo Turno): ${command}`,
      );
      return Promise.resolve(allowed);
    }
    const approval = this.repos.approvals.put({
      id: newId('approval'),
      runId: run.id,
      taskId,
      workerId: worker.id,
      kind: 'command',
      title: `${worker.name} quer executar um comando`,
      detail: command,
      status: 'pending',
      createdAt: nowIso(),
      resolvedAt: null,
    });
    this.update(taskId, { status: 'waiting_approval', workerState: 'waiting_approval' });
    this.log(run, taskId, worker.id, 'approval.requested', 'info', command, {
      approvalId: approval.id,
    });
    this.options.onChange('approval', approval.id);
    return new Promise((resolve) => this.pendingApprovals.set(approval.id, resolve));
  }

  private denyApprovalsOf(taskId: string): void {
    for (const approval of this.repos.approvals.list(
      "status = 'pending' AND task_id = ?",
      taskId,
    )) {
      this.repos.approvals.put({ ...approval, status: 'expired', resolvedAt: nowIso() });
      this.pendingApprovals.get(approval.id)?.(false);
      this.pendingApprovals.delete(approval.id);
      this.options.onChange('approval', approval.id);
    }
  }

  private onRuntimeEvent(run: Run, taskId: string, workerId: string, event: RuntimeEvent): void {
    this.log(run, taskId, workerId, event.type, event.level, event.message, event.data);
    if (event.type !== 'worker.state') return;
    const state = workerStateSchema.safeParse(event.data?.state);
    const task = this.repos.tasks.get(taskId);
    if (state.success && task && task.workerState !== state.data && task.status === 'running')
      this.update(taskId, { workerState: state.data });
  }

  private update(taskId: string, patch: Partial<Task>): Task {
    const current = this.repos.tasks.require(taskId, 'Tarefa');
    // An error comes from outside (a process, a provider): it is stored and shown bounded.
    if (typeof patch.error === 'string') patch = { ...patch, error: clipText(patch.error) };
    const next = this.repos.tasks.put({ ...current, ...patch });
    this.options.onChange('task', taskId);
    return next;
  }

  /** An entry in a run's log from Hive Teams: an agent created, work delegated, a review. */
  logTeam(
    runId: string,
    taskId: string | null,
    workerId: string | null,
    level: AgentEvent['level'],
    message: string,
    data?: Record<string, unknown>,
  ): void {
    const run = this.repos.runs.get(runId);
    if (run) this.log(run, taskId, workerId, 'team', level, message, data);
  }

  private log(
    run: Run,
    taskId: string | null,
    workerId: string | null,
    type: AgentEventType,
    level: AgentEvent['level'],
    message: string,
    data?: Record<string, unknown>,
  ): void {
    const event: AgentEvent = {
      id: newId('event'),
      ts: nowIso(),
      workspaceId: run.workspaceId,
      runId: run.id,
      taskId,
      workerId,
      type,
      level,
      message: secretRedactor.redact(clipText(message)),
      data:
        type === 'task.status' && taskId
          ? {
              ...data,
              status: this.repos.tasks.get(taskId)?.status ?? null,
              attempt: this.repos.tasks.get(taskId)?.attempt ?? null,
            }
          : type === 'run.status'
            ? { ...data, status: this.repos.runs.get(run.id)?.status ?? run.status }
            : (data ?? null),
    };
    this.repos.appendEvent(event);
    this.options.onEvent(event);
  }
}

/** Two memories handed to one session: texts side by side, tools together (first one wins a name). */
function mergeMemory(first: AgentMemory, second: AgentMemory): AgentMemory {
  const names = new Set(first.tools.map((tool) => tool.definition.function.name));
  return {
    context: [first.context, second.context].filter(Boolean).join('\n\n'),
    guidance: [first.guidance, second.guidance].filter(Boolean).join('\n\n'),
    tools: [
      ...first.tools,
      ...second.tools.filter((tool) => !names.has(tool.definition.function.name)),
    ],
  };
}

/**
 * The tasks whose results a new task starts from: each dependency's own commit, or, for a
 * dependency that changed nothing (so has no commit of its own), the results it started from.
 * Without this, work would be lost behind a task that only checked or coordinated.
 */
export function integrationSources(upstream: Task[], tasks: Task[]): Task[] {
  const sources = new Map<string, Task>();
  const seen = new Set<string>();
  const visit = (task: Task) => {
    if (seen.has(task.id)) return;
    seen.add(task.id);
    if (task.branch && task.result?.commit) {
      sources.set(task.id, task);
      return;
    }
    for (const key of task.dependsOn) {
      const dependency = tasks.find((item) => item.key === key);
      if (dependency) visit(dependency);
    }
  };
  for (const task of upstream) visit(task);
  return [...sources.values()];
}
