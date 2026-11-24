import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  type CanvasLayout,
  type FlowBlock,
  type FlowBlockState,
  type Run,
  type Task,
} from '@hive/core';
import type { Repositories } from '@hive/persistence';
import { nowIso } from '@hive/shared';
import { git, linkDependencies, unlinkDependencies } from '@hive/workspace';

/** A check that runs longer than this is stopped and counts as failed. */
const CHECK_TIMEOUT_MS = 10 * 60_000;
/** How much of a failing command's output goes back to the agent. */
const OUTPUT_TAIL = 4_000;
const TICK_MS = 30_000;
/** Checks run on each attempt of a task with several attempts; each may take minutes. */
const MAX_CANDIDATE_CHECKS = 4;

/**
 * Commands a check block may run: a package manager script or a known test runner, with plain
 * arguments. Blocks are written by the user or proposed by the Queen, and both run on their own,
 * so anything else (pipes, redirections, chained commands) is refused.
 */
const ALLOWED_COMMAND =
  /^(?:(?:npm|pnpm|yarn|bun)(?: run)? [\w:.@/-]+|npm test|pnpm test|yarn test|bun test|npx (?:vitest|jest|tsc|eslint|prettier)(?: [\w:./=-]+)*|pytest(?: [\w:./=-]+)*|python -m pytest(?: [\w:./=-]+)*|cargo (?:test|check|build|clippy)|go (?:test|vet|build) [\w./-]+|dotnet (?:test|build)|mvn (?:test|verify)|gradle (?:test|build)|make [\w-]+)$/;

export function allowedCheckCommand(command: string): boolean {
  return ALLOWED_COMMAND.test(command.trim());
}

/** What reached a block: the finished task it is about, or the run it belongs to. */
interface FlowContext {
  runId: string;
  task: Task | null;
  /** Output of the check that failed, for the agent to fix. */
  failure?: { blockId: string; command: string; output: string };
}

export interface FlowEngineOptions {
  repos: Repositories;
  layout: (runId: string) => CanvasLayout;
  /** Hive's worktree folder for a project, where checks get their own temporary checkout. */
  worktreeRoot: (workspaceId: string) => string;
  /** Sends a task back to its agent with a note (a failed check). */
  revise: (taskId: string, note: string) => void;
  /** Applies a finished task to the project (an approval). */
  approve: (taskId: string) => Promise<unknown>;
  /** Starts (or queues) a run, for a schedule. */
  start: (runId: string) => Promise<void>;
  notify: (title: string, body: string) => void;
  onChange: (runId: string) => void;
  log: (runId: string, message: string, level?: 'info' | 'warn' | 'error') => void;
}

/**
 * Runs the flow blocks of every canvas: when an agent finishes a task, what is linked after it
 * runs (a check, an approval, a notification), and schedules start their run on time. It never
 * changes the plan; it uses the same scheduler actions as the user (revise, approve, start).
 */
export class FlowEngine {
  private readonly states = new Map<string, Record<string, FlowBlockState>>();
  /** Block+task+attempt already handled, so a repeated change never runs a check twice. */
  private readonly handled = new Set<string>();
  /** Failures sent back to the agent, per check and task. */
  private readonly sentBack = new Map<string, number>();
  /** Tasks waiting at an approval block, by block. */
  private readonly waiting = new Map<string, Set<string>>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: FlowEngineOptions) {}

  start(): void {
    this.timer ??= setInterval(() => this.tick(new Date()), TICK_MS);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** What each block of a run did last. */
  state(runId: string): Record<string, FlowBlockState> {
    return { ...this.states.get(runId) };
  }

  /** A task changed: when it just finished, what is linked after its agent runs. */
  onTask(task: Task): void {
    // A candidate is one attempt of a task: the task, once its best attempt is chosen, goes on.
    if (task.status !== 'completed' || !task.workerId || task.candidateOf) return;
    if (this.partOfTeamWork(task)) return;
    const key = `${task.id}:${task.attempt}:${task.revision?.round ?? 0}`;
    if (this.handled.has(`done:${key}`)) return;
    this.handled.add(`done:${key}`);
    this.fire(`agent:${task.workerId}`, 'out', { runId: task.runId, task });
  }

  /**
   * Hive Teams: a member's or reviewer's piece, or a leader's session that delegated, is not the
   * team's result: the consolidation that follows it is. Checking or applying the piece would send
   * the leader back to code what its members are coding, or apply half the work.
   */
  private partOfTeamWork(task: Task): boolean {
    if (!task.team || task.team.role === 'consolidate') return false;
    if (task.team.role !== 'lead') return true;
    return this.options.repos.tasks
      .list('run_id = ?', task.runId)
      .some((item) => item.team?.role === 'consolidate' && item.team.leadTaskId === task.id);
  }

  /** A run changed: when it finished, what is linked after its Queen runs (a notification). */
  onRun(run: Run): void {
    if (!['review', 'completed', 'failed'].includes(run.status) || !run.queenWorkerId) return;
    const key = `run:${run.id}:${run.status}:${run.finishedAt ?? ''}`;
    if (this.handled.has(key)) return;
    this.handled.add(key);
    this.fire(`agent:${run.queenWorkerId}`, 'out', { runId: run.id, task: null });
  }

  /** Commands the project offers, for the check block's suggestions. */
  async commands(workspacePath: string): Promise<string[]> {
    const found: string[] = [];
    try {
      const manifest = JSON.parse(await readFile(path.join(workspacePath, 'package.json'), 'utf8'));
      const manager = (await exists(path.join(workspacePath, 'pnpm-lock.yaml')))
        ? 'pnpm'
        : (await exists(path.join(workspacePath, 'yarn.lock')))
          ? 'yarn'
          : 'npm';
      const scripts = Object.keys((manifest as { scripts?: object }).scripts ?? {});
      const preferred = ['test', 'lint', 'typecheck', 'build', 'check', 'format:check'];
      for (const name of [...preferred, ...scripts])
        if (scripts.includes(name)) found.push(`${manager} run ${name}`);
    } catch {
      // Not a Node project.
    }
    if (await exists(path.join(workspacePath, 'Cargo.toml'))) found.push('cargo test');
    if (await exists(path.join(workspacePath, 'go.mod'))) found.push('go test ./...');
    if (
      (await exists(path.join(workspacePath, 'pyproject.toml'))) ||
      (await exists(path.join(workspacePath, 'pytest.ini')))
    )
      found.push('pytest');
    return [...new Set(found)].filter(allowedCheckCommand);
  }

  /**
   * The checks that compare attempts of a task: the project's tests, lint, type check and build,
   * never a script that keeps running (dev, start, watch).
   */
  async verificationCommands(workspacePath: string): Promise<string[]> {
    const verifying =
      /(?:^|\s)(?:run )?(?:test|lint|typecheck|build|check)$|^(?:cargo test|go test|pytest)/;
    return (await this.commands(workspacePath))
      .filter((command) => verifying.test(command))
      .slice(0, MAX_CANDIDATE_CHECKS);
  }

  /** Runs `commands` on `commit` in a temporary checkout of the project; which passed. */
  async checkCommit(
    workspace: { id: string; path: string },
    commit: string,
    commands: string[],
  ): Promise<{ command: string; ok: boolean }[]> {
    if (!commands.length) return [];
    const target = path.join(
      this.options.worktreeRoot(workspace.id),
      `check-${randomUUID().slice(0, 8)}`,
    );
    const results: { command: string; ok: boolean }[] = [];
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await git(workspace.path, ['worktree', 'add', '--detach', target, commit], {
        timeoutMs: 180_000,
      });
      await linkDependencies(workspace.path, target);
      for (const command of commands)
        results.push({ command, ok: (await runCommand(command, target)).code === 0 });
    } finally {
      await unlinkDependencies(target);
      await git(workspace.path, ['worktree', 'remove', '--force', target], { allowFailure: true });
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
      await git(workspace.path, ['worktree', 'prune'], { allowFailure: true });
    }
    return results;
  }

  /** The tasks waiting at an approval block are applied now. */
  async approveWaiting(runId: string, blockId: string): Promise<void> {
    const block = this.block(runId, blockId);
    if (!block || block.kind !== 'approval') return;
    const tasks = [...(this.waiting.get(blockId) ?? [])];
    this.waiting.delete(blockId);
    for (const taskId of tasks) await this.applyTask(runId, block, taskId);
  }

  /** A schedule block fires now. */
  trigger(runId: string, blockId: string): void {
    const block = this.block(runId, blockId);
    if (block?.kind !== 'schedule') return;
    this.setState(runId, block.id, 'done', 'Disparado agora');
    this.fire(block.id, 'out', { runId, task: null }, runId);
  }

  /** Schedules whose time has come start their run, once per day. */
  tick(now: Date): void {
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    for (const run of this.options.repos.runs.list()) {
      const layout = this.options.layout(run.id);
      for (const block of layout.flow) {
        if (block.kind !== 'schedule' || !block.time) continue;
        if (block.days?.length && !block.days.includes(now.getDay())) continue;
        if (hhmm < block.time) continue;
        const key = `flowFired:${block.id}`;
        if (this.options.repos.getValue(key) === day) continue;
        // Only within the hour after the time, so opening Hive at night does not fire the morning.
        const [hours, minutes] = block.time.split(':').map(Number) as [number, number];
        if (now.getHours() * 60 + now.getMinutes() - (hours * 60 + minutes) > 60) continue;
        this.options.repos.setValue(key, day);
        this.setState(run.id, block.id, 'done', `Disparado às ${hhmm}`);
        this.fire(block.id, 'out', { runId: run.id, task: null }, run.id);
      }
    }
  }

  /* ---------------------------------------------------------------- internals */

  private block(runId: string, id: string): FlowBlock | undefined {
    return this.options.layout(runId).flow.find((block) => block.id === id);
  }

  /** Everything linked from `source` on `port` receives the context. */
  private fire(
    source: string,
    port: 'out' | 'pass' | 'fail',
    context: FlowContext,
    runId = context.runId,
  ): void {
    const layout = this.options.layout(runId);
    for (const link of layout.links) {
      if (link.source !== source || link.port !== port) continue;
      const block = layout.flow.find((item) => item.id === link.target);
      if (block) void this.run(block, context);
      else if (link.target.startsWith('agent:')) {
        const from = layout.flow.find((item) => item.id === source);
        if (from?.kind === 'schedule') void this.startRun(runId, from.id);
        else void this.toAgent(link.target.slice(6), context);
      }
    }
  }

  private async run(block: FlowBlock, context: FlowContext): Promise<void> {
    try {
      if (block.kind === 'check') await this.check(block, context);
      else if (block.kind === 'approval') await this.approval(block, context);
      else if (block.kind === 'notify') this.notification(block, context);
    } catch (error) {
      this.setState(context.runId, block.id, 'failed', message(error));
    }
  }

  /** Runs the block's command on the task's result, in a temporary checkout of its commit. */
  private async check(block: FlowBlock, context: FlowContext): Promise<void> {
    const task = context.task;
    if (!task?.result?.commit) {
      this.setState(
        context.runId,
        block.id,
        'failed',
        'A tarefa não deixou alterações para verificar.',
      );
      return;
    }
    const command = block.command?.trim() ?? '';
    if (!command) {
      this.setState(context.runId, block.id, 'failed', 'Escolha o comando da verificação.');
      return;
    }
    if (!allowedCheckCommand(command)) {
      this.setState(context.runId, block.id, 'failed', `Comando não permitido: ${command}`);
      return;
    }
    const key = `${block.id}:${task.id}:${task.result.commit}`;
    if (this.handled.has(key)) return;
    this.handled.add(key);
    const run = this.options.repos.runs.require(task.runId, 'Execução');
    const workspace = this.options.repos.workspaces.require(run.workspaceId, 'Projeto');
    this.setState(context.runId, block.id, 'running', `${command} · ${task.key}`);
    const started = Date.now();
    const target = path.join(
      this.options.worktreeRoot(workspace.id),
      `check-${randomUUID().slice(0, 8)}`,
    );
    let result: { code: number; output: string };
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await git(workspace.path, ['worktree', 'add', '--detach', target, task.result.commit], {
        timeoutMs: 180_000,
      });
      // The project's installed dependencies serve the checkout too, so tests can run.
      await linkDependencies(workspace.path, target);
      // A project started from scratch has none in its folder yet: the agents installed them in
      // their own checkouts. They are installed here first, or every check fails on a missing
      // tool instead of on the agent's code.
      const install = await installCommand(target);
      result = { code: 0, output: '' };
      if (install) {
        this.setState(context.runId, block.id, 'running', `Instalando dependências · ${task.key}`);
        const installed = await runCommand(install, target);
        if (installed.code !== 0)
          result = {
            code: installed.code,
            output: `"${install}" falhou antes da verificação; confira o package.json e as dependências.\n\n${installed.output}`,
          };
        else this.setState(context.runId, block.id, 'running', `${command} · ${task.key}`);
      }
      if (result.code === 0) result = await runCommand(command, target);
    } finally {
      await unlinkDependencies(target);
      await git(workspace.path, ['worktree', 'remove', '--force', target], { allowFailure: true });
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
      await git(workspace.path, ['worktree', 'prune'], { allowFailure: true });
    }
    const durationMs = Date.now() - started;
    if (result.code === 0) {
      this.setState(
        context.runId,
        block.id,
        'passed',
        `${command} passou · ${task.key}`,
        durationMs,
      );
      this.options.log(context.runId, `Verificação "${command}" passou em ${task.key}.`);
      this.fire(block.id, 'pass', context);
    } else {
      this.setState(
        context.runId,
        block.id,
        'failed',
        `${command} falhou · ${task.key}`,
        durationMs,
      );
      this.options.log(context.runId, `Verificação "${command}" falhou em ${task.key}.`, 'warn');
      this.fire(block.id, 'fail', {
        ...context,
        failure: { blockId: block.id, command, output: result.output.slice(-OUTPUT_TAIL) },
      });
    }
  }

  /** A failed check linked back to an agent: the task goes back to it with the output. */
  private async toAgent(workerId: string, context: FlowContext): Promise<void> {
    const { task, failure } = context;
    if (!task || !failure || task.workerId !== workerId) return;
    const block = this.block(context.runId, failure.blockId);
    const limit = block?.retries ?? 1;
    const key = `${failure.blockId}:${task.id}`;
    const sent = this.sentBack.get(key) ?? 0;
    if (sent >= limit) {
      this.setState(
        context.runId,
        failure.blockId,
        'failed',
        `${failure.command} ainda falha depois de ${sent} correção(ões) · ${task.key}`,
      );
      this.options.notify(
        'Verificação ainda falhando',
        `${task.title}: ${failure.command} falhou de novo.`,
      );
      return;
    }
    this.sentBack.set(key, sent + 1);
    this.options.revise(
      task.id,
      `A verificação "${failure.command}" falhou no seu resultado. Corrija o que causou a falha sem desativar testes ou regras. Saída do comando (final):\n\n${failure.output}`,
    );
    this.options.log(
      context.runId,
      `${task.key} voltou ao agente para corrigir "${failure.command}".`,
      'warn',
    );
  }

  private async approval(block: FlowBlock, context: FlowContext): Promise<void> {
    const task = context.task;
    if (!task) return;
    if (block.auto) {
      await this.applyTask(context.runId, block, task.id);
      return;
    }
    const waiting = this.waiting.get(block.id) ?? new Set<string>();
    waiting.add(task.id);
    this.waiting.set(block.id, waiting);
    this.setState(context.runId, block.id, 'waiting', `${waiting.size} tarefa(s) aguardando você`);
    this.options.notify('Aprovação pendente', `${task.title} passou e espera você aplicar.`);
  }

  private async applyTask(runId: string, block: FlowBlock, taskId: string): Promise<void> {
    const task = this.options.repos.tasks.get(taskId);
    if (!task || task.status !== 'completed') return;
    await this.options.approve(taskId);
    this.setState(runId, block.id, 'done', `${task.key} aplicada no projeto`);
    this.options.log(runId, `${task.key} aplicada pelo bloco de aprovação.`);
    this.fire(block.id, 'out', { runId, task: this.options.repos.tasks.get(taskId) ?? task });
  }

  private notification(block: FlowBlock, context: FlowContext): void {
    const run = this.options.repos.runs.get(context.runId);
    const mission = run ? this.options.repos.missions.get(run.missionId) : null;
    const title = mission?.title ?? 'Hive';
    const body = context.task
      ? `${context.task.title}: ${context.task.status === 'completed' ? 'pronta' : context.task.status}.`
      : run?.status === 'failed'
        ? 'A missão terminou com falhas.'
        : 'A equipe terminou a missão.';
    this.options.notify(title, body);
    this.setState(context.runId, block.id, 'done', body);
  }

  private setState(
    runId: string,
    blockId: string,
    status: FlowBlockState['status'],
    detail: string,
    durationMs: number | null = null,
  ): void {
    const states = this.states.get(runId) ?? {};
    states[blockId] = { status, detail, at: nowIso(), durationMs };
    this.states.set(runId, states);
    this.options.onChange(runId);
  }

  /** Schedule → agent: the run starts (the Queen plans first when there is no plan yet). */
  private async startRun(runId: string, blockId: string): Promise<void> {
    try {
      await this.options.start(runId);
      this.options.log(runId, 'O agendamento iniciou a missão.');
    } catch (error) {
      this.setState(runId, blockId, 'failed', message(error));
    }
  }
}

/**
 * The install a checkout needs before its checks can run: a Node project with no dependencies
 * folder (nor a link to the project's), with the package manager its lockfile names. Null when
 * nothing is missing or it is not a Node project.
 */
export async function installCommand(checkout: string): Promise<string | null> {
  if (!(await exists(path.join(checkout, 'package.json')))) return null;
  if (await exists(path.join(checkout, 'node_modules'))) return null;
  if (await exists(path.join(checkout, 'pnpm-lock.yaml'))) return 'pnpm install';
  if (await exists(path.join(checkout, 'yarn.lock'))) return 'yarn install';
  if (await exists(path.join(checkout, 'bun.lockb'))) return 'bun install';
  return 'npm install --no-audit --no-fund';
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false,
  );
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Runs a command in a shell, with a time limit; returns the exit code and the output. */
function runCommand(command: string, cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, CI: '1', FORCE_COLOR: '0' };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const child = spawn(command, { cwd, env, shell: true, windowsHide: true });
    let output = '';
    const take = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-OUTPUT_TAIL * 4);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => {
      output += `\n[parado depois de ${CHECK_TIMEOUT_MS / 60_000} minutos]`;
      child.kill();
    }, CHECK_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 1, output: `${output}\n${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
  });
}
