import {
  activeStatuses,
  isBlockedByFailure,
  readyTasks,
  stateForTaskStatus,
  workerStateSchema,
  type AgentEvent,
  type AgentEventType,
  type Run,
  type RunStatus,
  type Task,
  type TaskResult,
  type Worker,
  type Workspace,
} from '@hive/core';
import type { AgentRuntime, AgentTaskInput, RuntimeEvent } from '@hive/agents';
import type { Repositories } from '@hive/persistence';
import type { ChatClient } from '@hive/providers';
import { HiveError, errorMessage, newId, nowIso, secretRedactor } from '@hive/shared';
import {
  WorktreeManager,
  diffRefs,
  git,
  hiveCommitFlags,
  inspectRepository,
  statusPorcelain,
  taskBranchName,
  type DiffResult,
} from '@hive/workspace';
import { buildRunReport } from './report';

export interface SchedulerOptions {
  repos: Repositories;
  runtime: AgentRuntime;
  chatFor: (providerId: string) => ChatClient;
  resolveSkills: (
    names: string[],
  ) => Promise<{ skills: AgentTaskInput['skills']; missing: string[] }>;
  /** Hive-owned folder for a workspace's task worktrees, outside the user's repository. */
  worktreeRoot: (workspace: Workspace) => string;
  onEvent: (event: AgentEvent) => void;
  onChange: (entity: 'run' | 'task' | 'approval', id: string) => void;
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

/**
 * Runs a planned mission. Each task gets its own worktree and `hive/` branch created from the
 * run's base commit plus the branches of its dependencies; the user's working tree is only
 * touched when they explicitly apply (approve) a finished task.
 */
export class Scheduler {
  /** taskId → runtime session id, for tasks whose agent is running. */
  private readonly sessions = new Map<string, string>();
  /** Tasks between "picked" and "agent started" (worktree setup). */
  private readonly launching = new Set<string>();
  private readonly cancelRequested = new Set<string>();
  private readonly pendingApprovals = new Map<string, (approved: boolean) => void>();

  constructor(private readonly options: SchedulerOptions) {}

  private get repos() {
    return this.options.repos;
  }

  /** Call once at startup: nothing can still be running after the app was closed. */
  recover(): void {
    for (const approval of this.repos.approvals.list("status = 'pending'"))
      this.repos.approvals.put({ ...approval, status: 'expired', resolvedAt: nowIso() });
    for (const run of this.repos.runs.list()) {
      if (run.status !== 'running') continue;
      for (const task of this.repos.tasks.list('run_id = ?', run.id)) {
        if (!activeStatuses.has(task.status)) continue;
        this.repos.tasks.put({
          ...task,
          status: 'failed',
          workerState: 'failed',
          worktreePath: null,
          error: 'O aplicativo fechou durante a execução. Tente novamente.',
          finishedAt: nowIso(),
        });
      }
      this.repos.runs.put({ ...run, status: 'failed', error: 'Execução interrompida.' });
      this.settle(run.id);
    }
  }

  /** Start (or resume) a run: unfinished tasks are reset and scheduled. */
  start(runId: string): Run {
    const run = this.repos.runs.require(runId, 'Execução');
    if (!RESUMABLE.has(run.status))
      throw new HiveError('CONFLICT', 'Esta missão não pode ser executada agora.');
    const tasks = this.repos.tasks.list('run_id = ?', runId);
    if (!tasks.length) throw new HiveError('VALIDATION', 'Gere um plano antes de executar.');
    const workers = this.repos.workers.list();
    const configured = (worker: Worker | undefined) =>
      !!worker && worker.role !== 'queen' && !!worker.providerId && !!worker.modelId;
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

  cancelTask(taskId: string): void {
    const task = this.repos.tasks.require(taskId, 'Tarefa');
    this.denyApprovalsOf(taskId);
    const session = this.sessions.get(taskId);
    if (session) void this.options.runtime.cancel(session);
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
    reset(task);
    for (const item of this.repos.tasks.list('run_id = ?', task.runId))
      if (item.status === 'cancelled' && item.error?.startsWith(BLOCKED)) reset(item);
    const run = this.repos.runs.require(task.runId, 'Execução');
    if (run.status !== 'running') {
      this.repos.runs.put({ ...run, status: 'running', error: null, finishedAt: null });
      this.options.onChange('run', run.id);
    }
    this.pump(task.runId);
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
      this.log(run, task.id, task.workerId, 'git', 'info', `Aplicado em ${run.baseBranch}.`);
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
    if (task.branch)
      await git(workspace.path, ['branch', '-D', task.branch], { allowFailure: true });
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

  isActive(runId: string): boolean {
    return this.repos.tasks
      .list('run_id = ?', runId)
      .some((task) => this.sessions.has(task.id) || this.launching.has(task.id));
  }

  /* ---------------------------------------------------------------- internals */

  private pumpAll(): void {
    for (const run of this.repos.runs.list()) if (run.status === 'running') this.pump(run.id);
  }

  private pump(runId: string): void {
    const run = this.repos.runs.get(runId);
    if (!run || run.status !== 'running') return;
    let tasks = this.repos.tasks.list('run_id = ?', runId);
    for (const task of tasks) {
      if (
        (task.status === 'pending' || task.status === 'blocked') &&
        isBlockedByFailure(task, tasks)
      )
        this.update(task.id, {
          status: 'cancelled',
          workerState: 'cancelled',
          error: `${BLOCKED}: ${task.dependsOn.join(', ')}.`,
          finishedAt: nowIso(),
        });
    }
    tasks = this.repos.tasks.list('run_id = ?', runId);
    const limit = this.repos.getSettings().maxConcurrentTasks;
    for (const task of readyTasks(tasks)) {
      if (this.sessions.size + this.launching.size >= limit) break;
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
    const tasks = this.repos.tasks.list('run_id = ?', runId);
    const busy = tasks.some(
      (task) =>
        activeStatuses.has(task.status) ||
        this.launching.has(task.id) ||
        this.sessions.has(task.id),
    );
    if (busy || (run.status === 'running' && readyTasks(tasks).length)) return;
    if (run.status === 'running' && tasks.some((task) => task.status === 'pending')) return;
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
    const checkCancelled = () => {
      if (this.cancelRequested.delete(initial.id))
        throw new HiveError('CANCELLED', 'Cancelada antes de começar.');
    };
    try {
      const worker = this.repos.workers.require(initial.workerId ?? '', 'Agente');
      if (!worker.providerId || !worker.modelId)
        throw new HiveError('VALIDATION', `${worker.name} não tem provedor e modelo configurados.`);
      this.update(initial.id, {
        status: 'running',
        workerState: 'planning',
        attempt,
        branch,
        error: null,
        result: null,
        startedAt: nowIso(),
        finishedAt: null,
      });
      this.log(run, initial.id, worker.id, 'task.status', 'info', `${worker.name} começou.`);
      const name = `${run.id.slice(-6)}-${initial.key}-a${attempt}`.replace(/[^\w-]+/g, '-');
      worktree = await manager.create(name, branch, run.baseCommit);
      const tasks = this.repos.tasks.list('run_id = ?', run.id);
      const upstream = initial.dependsOn
        .map((key) => tasks.find((task) => task.key === key))
        .filter((task): task is Task => !!task);
      for (const dependency of upstream)
        if (dependency.branch && dependency.result?.commit) {
          await manager.mergeBranch(worktree, dependency.result.commit);
          this.log(run, initial.id, worker.id, 'git', 'debug', `Incluído: ${dependency.title}`);
        }
      const startCommit = (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim();
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

      const session = await this.options.runtime.start({
        sessionId,
        task: {
          title: initial.title,
          description: initial.description,
          acceptanceCriteria: initial.acceptanceCriteria,
          upstream: upstream.map((task) => ({
            title: task.title,
            summary: task.result?.summary ?? '',
          })),
        },
        worker,
        model: worker.modelId,
        chat: this.options.chatFor(worker.providerId),
        worktreePath: worktree,
        skills,
        limits: worker.limits,
        requestApproval: ({ command }) => this.requestApproval(run, initial.id, worker, command),
      });
      this.sessions.set(initial.id, sessionId);
      this.launching.delete(initial.id);
      const unsubscribe = this.options.runtime.subscribe(sessionId, (event) =>
        this.onRuntimeEvent(run, initial.id, worker.id, event),
      );
      if (this.cancelRequested.delete(initial.id)) void this.options.runtime.cancel(sessionId);
      const outcome = await session.done;
      unsubscribe();

      commit = await manager.commitAll(worktree, `hive: ${initial.title}`);
      const diff = commit ? await diffRefs(worktree, startCommit, commit) : null;
      const result: TaskResult = {
        summary: outcome.summary,
        filesChanged: diff?.files.map((file) => ({ path: file.path, status: file.status })) ?? [],
        insertions: diff?.insertions ?? 0,
        deletions: diff?.deletions ?? 0,
        commit,
        commands: outcome.commands,
        usage: outcome.usage,
      };
      this.update(initial.id, {
        status: outcome.status,
        workerState: stateForTaskStatus(outcome.status) ?? 'idle',
        result,
        error: outcome.error,
        finishedAt: nowIso(),
        worktreePath: null,
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
    } catch (error) {
      const cancelled = error instanceof HiveError && error.code === 'CANCELLED';
      const message = secretRedactor.redact(errorMessage(error));
      this.update(initial.id, {
        status: cancelled ? 'cancelled' : 'failed',
        workerState: cancelled ? 'cancelled' : 'failed',
        error: message,
        finishedAt: nowIso(),
        worktreePath: null,
      });
      this.log(run, initial.id, initial.workerId, 'error', cancelled ? 'warn' : 'error', message);
    } finally {
      this.launching.delete(initial.id);
      this.sessions.delete(initial.id);
      this.cancelRequested.delete(initial.id);
      this.denyApprovalsOf(initial.id);
      // The branch is kept only when it holds work to review.
      if (worktree) await manager.remove(worktree, commit ? null : branch).catch(() => undefined);
      this.pumpAll();
      this.settle(run.id);
    }
  }

  private requestApproval(
    run: Run,
    taskId: string,
    worker: Worker,
    command: string,
  ): Promise<boolean> {
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
    const next = this.repos.tasks.put({ ...current, ...patch });
    this.options.onChange('task', taskId);
    return next;
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
      message: secretRedactor.redact(message),
      data: data ?? null,
    };
    this.repos.appendEvent(event);
    this.options.onEvent(event);
  }
}
