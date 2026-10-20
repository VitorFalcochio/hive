import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultLimits, type Run, type Task } from '@hive/core';
import type { AgentOutcome, AgentRuntime, AgentTaskInput, RuntimeEvent } from '@hive/agents';
import { HiveDatabase, Repositories } from '@hive/persistence';
import { Scheduler } from './scheduler';

type Behaviour = (input: AgentTaskInput) => Promise<Partial<AgentOutcome>>;

/** Stands in for a model: each task's behaviour edits the worktree directly. */
class FakeRuntime implements AgentRuntime {
  readonly id = 'fake';
  constructor(private readonly behaviour: Behaviour) {}
  async start(input: AgentTaskInput) {
    const done = this.behaviour(input).then((partial): AgentOutcome => ({
      status: 'completed',
      summary: `Feito: ${input.task.title}`,
      error: null,
      steps: 1,
      usage: { promptTokens: 10, completionTokens: 5 },
      commands: [],
      ...partial,
    }));
    return { id: input.sessionId, done };
  }
  async cancel() {}
  subscribe(_id: string, _listener: (event: RuntimeEvent) => void) {
    return () => undefined;
  }
}

const databases: HiveDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

async function setup(behaviour: Behaviour, tasks: { key: string; dependsOn?: string[] }[]) {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'hive-sched-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, windowsHide: true }).toString();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@hive.local');
  await writeFile(path.join(repo, 'README.md'), '# base\n');
  git('add', '.');
  git('-c', 'core.hooksPath=', 'commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();

  const db = new HiveDatabase(':memory:');
  databases.push(db);
  const repos = new Repositories(db);
  const at = new Date().toISOString();
  repos.workspaces.put({
    id: 'ws',
    name: 'repo',
    path: repo,
    defaultBranch: 'main',
    createdAt: at,
    lastOpenedAt: at,
  });
  repos.workers.put({
    id: 'w1',
    name: 'Backend',
    role: 'backend',
    description: '',
    providerId: 'p1',
    modelId: 'm1',
    skills: [],
    tools: [],
    autoApproveCommands: [],
    systemPrompt: '',
    limits: defaultLimits,
    createdAt: at,
    updatedAt: at,
  });
  repos.missions.put({
    id: 'm',
    workspaceId: 'ws',
    title: 'Missão',
    objective: 'x',
    createdAt: at,
  });
  const run: Run = {
    id: 'run_test1234',
    missionId: 'm',
    workspaceId: 'ws',
    status: 'awaiting_plan_approval',
    baseBranch: 'main',
    baseCommit: base,
    queenWorkerId: null,
    planNotes: null,
    report: null,
    error: null,
    createdAt: at,
    finishedAt: null,
  };
  repos.runs.put(run);
  for (const item of tasks)
    repos.tasks.put({
      id: `task_${item.key}`,
      runId: run.id,
      key: item.key,
      title: `Tarefa ${item.key}`,
      description: 'd',
      workerId: null, // unassigned: the scheduler must fall back to a configured worker
      dependsOn: item.dependsOn ?? [],
      acceptanceCriteria: ['ok'],
      status: 'pending',
      workerState: 'idle',
      attempt: 0,
      branch: null,
      startCommit: null,
      worktreePath: null,
      result: null,
      error: null,
      createdAt: at,
      startedAt: null,
      finishedAt: null,
    });
  const scheduler = new Scheduler({
    repos,
    runtime: new FakeRuntime(behaviour),
    chatFor: () => ({ chat: () => Promise.reject(new Error('unused')) }),
    resolveSkills: async () => ({ skills: [], missing: [] }),
    worktreeRoot: () => path.join(repo, '..', `${path.basename(repo)}-worktrees`),
    onEvent: () => undefined,
    onChange: () => undefined,
  });
  const task = (key: string) => repos.tasks.require(`task_${key}`, 'Tarefa');
  const status = () => repos.runs.require(run.id, 'Execução').status;
  return { repo, repos, scheduler, run, task, status, git };
}

async function until(check: () => boolean, what: string, timeoutMs = 20_000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const writeTaskFile = (input: AgentTaskInput) =>
  writeFile(path.join(input.worktreePath, `${input.task.title}.txt`), input.task.title);

// Real git worktrees are slow on Windows, especially when test files run in parallel.
describe('Scheduler', { timeout: 60_000 }, () => {
  it('executa em ordem de dependência, isola o diff e aplica no repositório', async () => {
    const sawUpstream: boolean[] = [];
    const ctx = await setup(
      async (input) => {
        if (input.task.title === 'Tarefa b')
          sawUpstream.push(existsSync(path.join(input.worktreePath, 'Tarefa a.txt')));
        await writeTaskFile(input);
        return {};
      },
      [{ key: 'a' }, { key: 'b', dependsOn: ['a'] }],
    );
    ctx.scheduler.start(ctx.run.id);
    await until(() => ctx.status() === 'review', 'review');

    expect(sawUpstream).toEqual([true]);
    const b = ctx.task('b');
    expect(b.workerId).toBe('w1');
    expect(b.result?.filesChanged.map((file) => file.path)).toEqual(['Tarefa b.txt']);
    const diff = await ctx.scheduler.diff(b.id);
    expect(diff.result?.patch).toContain('+Tarefa b');
    expect(diff.result?.patch).not.toContain('Tarefa a.txt');
    // Nothing reached the user's working tree yet.
    expect(existsSync(path.join(ctx.repo, 'Tarefa a.txt'))).toBe(false);

    await ctx.scheduler.approve('task_a');
    await ctx.scheduler.approve('task_b');
    expect(await readFile(path.join(ctx.repo, 'Tarefa b.txt'), 'utf8')).toBe('Tarefa b');
    expect(ctx.status()).toBe('completed');
    expect(ctx.git('status', '--porcelain')).toBe('');
  });

  it('pausa em comandos até o usuário responder', async () => {
    const answers: boolean[] = [];
    const ctx = await setup(
      async (input) => {
        answers.push(await input.requestApproval({ command: 'npm test' }));
        await writeTaskFile(input);
        return {};
      },
      [{ key: 'a' }],
    );
    ctx.scheduler.start(ctx.run.id);
    await until(() => ctx.task('a').status === 'waiting_approval', 'approval');
    const [approval] = ctx.repos.approvals.list("status = 'pending'");
    expect(approval?.detail).toBe('npm test');
    ctx.scheduler.resolveApproval(approval!.id, true, true);
    await until(() => ctx.status() === 'review', 'review');
    expect(answers).toEqual([true]);
    expect(ctx.repos.workers.require('w1', 'Agente').autoApproveCommands).toEqual(['npm test']);
  });

  it('cancela dependentes quando uma tarefa falha e retoma no retry', async () => {
    let fail = true;
    const ctx = await setup(
      async (input) => {
        if (input.task.title === 'Tarefa a' && fail)
          return { status: 'failed', error: 'quebrou', summary: '' };
        await writeTaskFile(input);
        return {};
      },
      [{ key: 'a' }, { key: 'b', dependsOn: ['a'] }],
    );
    ctx.scheduler.start(ctx.run.id);
    await until(() => ctx.status() === 'failed', 'failed run');
    expect(ctx.task('a').status).toBe('failed');
    expect(ctx.task('b').status).toBe('cancelled');

    fail = false;
    ctx.scheduler.retry('task_a');
    await until(() => ctx.status() === 'review', 'review after retry');
    const statuses = (['a', 'b'] as const).map((key) => ctx.task(key));
    expect(statuses.map((task: Task) => task.status)).toEqual(['completed', 'completed']);
    expect(ctx.task('a').attempt).toBe(2);
  });
});
