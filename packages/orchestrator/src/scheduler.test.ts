import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultLimits, type Run, type Task } from '@hive/core';
import type { AgentOutcome, AgentRuntime, AgentTaskInput, RuntimeEvent } from '@hive/agents';
import { HiveDatabase, Repositories } from '@hive/persistence';
import { Scheduler, type SchedulerOptions } from './scheduler';

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

async function setup(
  behaviour: Behaviour,
  tasks: { key: string; dependsOn?: string[] }[],
  unattended = false,
  hooks: Pick<
    SchedulerOptions,
    'holds' | 'onTaskFailed' | 'runtimeFor' | 'candidateModels' | 'checkCandidate'
  > = {},
) {
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
    beeColor: null,
    squad: [],
    description: '',
    providerId: 'p1',
    modelId: 'm1',
    skills: [],
    tools: [],
    autoApproveCommands: [],
    mcpServers: [],
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
  const worktreeRoot = path.join(repo, '..', `${path.basename(repo)}-worktrees`);
  const build = (next: Behaviour) =>
    new Scheduler({
      repos,
      runtime: new FakeRuntime(next),
      chatFor: () => ({ chat: () => Promise.reject(new Error('unused')) }),
      resolveSkills: async () => ({ skills: [], missing: [] }),
      worktreeRoot: () => worktreeRoot,
      onEvent: () => undefined,
      onChange: () => undefined,
      unattended: () => unattended,
      ...hooks,
    });
  const scheduler = build(behaviour);
  const task = (key: string) => repos.tasks.require(`task_${key}`, 'Tarefa');
  const status = () => repos.runs.require(run.id, 'Execução').status;
  /** A new Scheduler over the same database: Hive opening again. */
  const reopen = (next: Behaviour) => build(next);
  return { repo, repos, scheduler, run, task, status, git, worktreeRoot, reopen };
}

async function until(check: () => boolean, what: string, timeoutMs = 60_000) {
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

  it('roda cada agente no motor escolhido para ele e cancela nesse mesmo motor', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const other = new FakeRuntime(async (input) => {
      await gate;
      await writeTaskFile(input);
      return {};
    });
    const started: string[] = [];
    const cancelled: string[] = [];
    const start = other.start.bind(other);
    other.start = async (input) => {
      started.push(input.task.title);
      return start(input);
    };
    other.cancel = async (id?: string) => {
      cancelled.push(id ?? '');
      release();
    };
    const ctx = await setup(async () => ({}), [{ key: 'a' }], false, {
      runtimeFor: (worker) => (worker.id === 'w1' ? other : null),
    });
    ctx.scheduler.start(ctx.run.id);
    await until(() => started.length === 1, 'o motor escolhido começar');
    ctx.scheduler.cancelTask('task_a');
    await until(() => ctx.status() !== 'running', 'a missão parar');
    expect(started).toEqual(['Tarefa a']);
    expect(cancelled).toHaveLength(1);
    await until(() => !ctx.scheduler.isActive(ctx.run.id), 'a tarefa terminar de vez');
  });

  it('uma falha cancela toda a cadeia que dependia dela, e a missão para', async () => {
    const ctx = await setup(
      async (input) =>
        input.task.title === 'Tarefa a' ? { status: 'failed', error: 'quebrou' } : {},
      [
        { key: 'a' },
        { key: 'b', dependsOn: ['a'] },
        { key: 'c', dependsOn: ['b'] },
        { key: 'd', dependsOn: ['c'] },
      ],
    );
    ctx.scheduler.start(ctx.run.id);
    await until(() => ctx.status() !== 'running', 'a missão parar');
    expect(ctx.status()).toBe('failed');
    expect(['b', 'c', 'd'].map((key) => ctx.task(key).status)).toEqual([
      'cancelled',
      'cancelled',
      'cancelled',
    ]);
  });

  it('o trabalho passa adiante mesmo atrás de uma tarefa que não alterou nada', async () => {
    const sawA: boolean[] = [];
    const ctx = await setup(
      async (input) => {
        if (input.task.title === 'Tarefa a') await writeTaskFile(input);
        if (input.task.title === 'Tarefa c')
          sawA.push(existsSync(path.join(input.worktreePath, 'Tarefa a.txt')));
        return {};
      },
      // b only checks: it changes no file, so it has no commit of its own.
      [{ key: 'a' }, { key: 'b', dependsOn: ['a'] }, { key: 'c', dependsOn: ['b'] }],
    );
    ctx.scheduler.start(ctx.run.id);
    await until(() => ctx.status() === 'review', 'review');
    expect(ctx.task('b').result?.commit).toBeNull();
    expect(sawA).toEqual([true]);
  });

  it('descartar uma tarefa só apaga a branch do Hive, nunca uma branch do usuário', async () => {
    const ctx = await setup(
      async (input) => {
        await writeTaskFile(input);
        return {};
      },
      [{ key: 'a' }, { key: 'b' }],
    );
    ctx.scheduler.start(ctx.run.id);
    await until(() => ctx.status() === 'review', 'review');
    const own = ctx.task('a').branch!;
    expect(own.startsWith('hive/')).toBe(true);
    await ctx.scheduler.reject('task_a');
    expect(ctx.git('branch', '--list', own).trim()).toBe('');

    // A record pointing at one of the user's branches (by a bug or a damaged database).
    ctx.git('branch', 'trabalho-do-usuario');
    ctx.repos.tasks.put({ ...ctx.task('b'), branch: 'trabalho-do-usuario' });
    await ctx.scheduler.reject('task_b');
    expect(ctx.git('branch', '--list', 'trabalho-do-usuario').trim()).toContain(
      'trabalho-do-usuario',
    );
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

  it('libera sozinho comandos que só leem, sem criar aprovação', async () => {
    const answers: boolean[] = [];
    const ctx = await setup(
      async (input) => {
        answers.push(await input.requestApproval({ command: 'git status && node --version' }));
        await writeTaskFile(input);
        return {};
      },
      [{ key: 'a' }],
    );
    ctx.scheduler.start(ctx.run.id);
    await until(() => ctx.status() === 'review', 'review');
    expect(answers).toEqual([true]);
    expect(ctx.repos.approvals.list()).toEqual([]);
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

  it('segura o ramo de uma tarefa falha durante o replanejamento e religa no reroute', async () => {
    const held = new Set<string>();
    const failedSeen: string[] = [];
    const ctx = await setup(
      async (input) => {
        if (input.task.title === 'Tarefa a') return { status: 'failed', error: 'boom' };
        await writeTaskFile(input);
        return {};
      },
      [{ key: 'a' }, { key: 'b', dependsOn: ['a'] }, { key: 'c' }],
      false,
      {
        onTaskFailed: (_run, task) => {
          failedSeen.push(task.key);
          held.add(task.id);
        },
        holds: (task) => held.has(task.id),
      },
    );
    ctx.scheduler.start(ctx.run.id);
    await until(
      () => ctx.task('a').status === 'failed' && ctx.task('c').status === 'completed',
      'a falha e c conclui',
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(failedSeen).toEqual(['a']);
    // Held: the dependent waits instead of being cancelled, and the run stays open.
    expect(ctx.task('b').status).toBe('pending');
    expect(ctx.status()).toBe('running');

    ctx.scheduler.addTask(ctx.run.id, {
      key: 'a2',
      title: 'Tarefa a2',
      description: 'outro caminho',
      workerId: 'w1',
      dependsOn: [],
      acceptanceCriteria: ['ok'],
    });
    ctx.scheduler.reroute('task_a', ['a2'], 'Replanejamento aprovado.');
    held.clear();
    await until(() => ctx.status() === 'review', 'review');

    expect(ctx.task('a').status).toBe('rejected');
    expect(ctx.task('a').error).toBe('Replanejamento aprovado.');
    expect(ctx.task('b').dependsOn).toEqual(['a2']);
    expect(ctx.task('b').status).toBe('completed');
  });

  it('encerrar o ramo em espera cancela os dependentes como sem replanejamento', async () => {
    const held = new Set<string>();
    const ctx = await setup(
      async (input) => {
        if (input.task.title === 'Tarefa a') return { status: 'failed', error: 'boom' };
        await writeTaskFile(input);
        return {};
      },
      [{ key: 'a' }, { key: 'b', dependsOn: ['a'] }],
      false,
      { onTaskFailed: (_run, task) => held.add(task.id), holds: (task) => held.has(task.id) },
    );
    ctx.scheduler.start(ctx.run.id);
    await until(() => ctx.task('a').status === 'failed', 'a falha');
    // The scheduler is done with the task once its worktree and empty branch are gone.
    await until(
      () =>
        ctx.git('worktree', 'list').trim().split('\n').length === 1 &&
        ctx.git('branch', '--list', 'hive/*').trim() === '',
      'worktree e branch removidos',
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ctx.status()).toBe('running');

    held.clear();
    ctx.scheduler.refresh(ctx.run.id);
    expect(ctx.task('b').status).toBe('cancelled');
    expect(ctx.status()).toBe('failed');
  });

  it('reroute recusa continuação desconhecida ou tarefa que não está falha', async () => {
    const ctx = await setup(async () => ({}), [{ key: 'a' }]);
    expect(() => ctx.scheduler.reroute('task_a', [], 'x')).toThrow('não está mais falha');
  });

  it('sem ninguém olhando, libera só comandos seguros e não cria pedidos', async () => {
    const answers: boolean[] = [];
    const ctx = await setup(
      async (input) => {
        answers.push(await input.requestApproval({ command: 'npm test' }));
        answers.push(await input.requestApproval({ command: 'npm install left-pad' }));
        answers.push(await input.requestApproval({ command: 'npm test && rm -rf /' }));
        await writeTaskFile(input);
        return {};
      },
      [{ key: 'a' }],
      true,
    );
    ctx.scheduler.start(ctx.run.id);
    await until(() => ctx.status() === 'review', 'review');
    expect(answers).toEqual([true, false, false]);
    expect(ctx.repos.approvals.list()).toEqual([]);
  });

  it('sem ninguém olhando, tenta de novo com o erro anterior até o limite', async () => {
    const descriptions: string[] = [];
    const ctx = await setup(
      async (input) => {
        descriptions.push(input.task.description);
        if (descriptions.length === 1)
          return { status: 'failed', error: 'teste vermelho', summary: '' };
        await writeTaskFile(input);
        return {};
      },
      [{ key: 'a' }],
      true,
    );
    ctx.scheduler.start(ctx.run.id);
    await until(() => ctx.status() === 'review', 'review after automatic retry');
    expect(ctx.task('a').attempt).toBe(2);
    expect(descriptions[0]).toBe('d');
    expect(descriptions[1]).toContain('A tentativa anterior falhou com este erro: teste vermelho');
  });

  it('para de tentar quando chega ao limite de tentativas', async () => {
    let calls = 0;
    const ctx = await setup(
      async () => {
        calls += 1;
        return { status: 'failed', error: `falha ${calls}`, summary: '' };
      },
      [{ key: 'a' }],
      true,
    );
    ctx.scheduler.start(ctx.run.id);
    await until(() => ctx.status() === 'failed', 'failed run');
    expect(calls).toBe(2);
    expect(ctx.task('a').error).toBe('falha 2');
  });

  it('revisa a partir da entrega anterior com os comentários do usuário', async () => {
    const seen: { review?: AgentTaskInput['task']['review']; hadFirst: boolean }[] = [];
    const ctx = await setup(
      async (input) => {
        const first = path.join(input.worktreePath, 'tela.txt');
        seen.push({ review: input.task.review, hadFirst: existsSync(first) });
        if (!input.task.review) await writeFile(first, 'botão azul\n');
        else await writeFile(path.join(input.worktreePath, 'ajuste.txt'), 'verde\n');
        return { summary: input.task.review ? 'Troquei a cor.' : 'Fiz a tela.' };
      },
      [{ key: 'a' }],
    );
    ctx.scheduler.start(ctx.run.id);
    await until(() => ctx.status() === 'review', 'first review');
    const firstBranch = ctx.task('a').branch!;

    ctx.scheduler.revise(
      'task_a',
      [{ path: 'tela.txt', line: 1, side: 'new', code: 'botão azul', body: 'Use verde.' }],
      'Mantenha o resto.',
    );
    await until(() => ctx.status() === 'review' && ctx.task('a').attempt === 2, 'revision');

    expect(seen[1]).toMatchObject({
      hadFirst: true,
      review: { round: 1, previousSummary: 'Fiz a tela.', note: 'Mantenha o resto.' },
    });
    expect(seen[1]!.review!.comments[0]!.body).toBe('Use verde.');
    // The diff still covers the whole task, not only the fix.
    const files = ctx
      .task('a')
      .result!.filesChanged.map((file) => file.path)
      .sort();
    expect(files).toEqual(['ajuste.txt', 'tela.txt']);
    expect(ctx.git('branch', '--list', firstBranch).trim()).toBe('');

    await ctx.scheduler.approve('task_a');
    // Git on Windows may convert line endings on checkout.
    expect((await readFile(path.join(ctx.repo, 'ajuste.txt'), 'utf8')).trimEnd()).toBe('verde');
  });

  it('recusa revisar tarefa que não está pronta ou sem comentários', async () => {
    const ctx = await setup(
      async (input) => {
        await writeTaskFile(input);
        return {};
      },
      [{ key: 'a' }],
    );
    expect(() => ctx.scheduler.revise('task_a', [], 'x')).toThrow(/prontas para revisão/);
    ctx.scheduler.start(ctx.run.id);
    await until(() => ctx.status() === 'review', 'review');
    expect(() => ctx.scheduler.revise('task_a', [], '  ')).toThrow(/ao menos um comentário/);
  });

  it('tarefa com mel fura a fila e roda com limites dobrados e esquadrão completo', async () => {
    const started: AgentTaskInput[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const ctx = await setup(
      async (input) => {
        started.push(input);
        await gate;
        await writeTaskFile(input);
        return {};
      },
      [{ key: 'a' }, { key: 'b' }, { key: 'c' }],
    );
    ctx.repos.workers.put({
      ...ctx.repos.workers.require('w1', 'Agente'),
      squad: [{ role: 'scout', enabled: false, modelId: null }],
    });
    ctx.scheduler.boost('task_c', true);
    ctx.scheduler.start(ctx.run.id);
    // Two at a time: the honeyed task takes one of the first two slots.
    await until(() => started.length === 2, 'two tasks');
    expect(started.map((input) => input.task.title).sort()).toEqual(['Tarefa a', 'Tarefa c']);

    const boosted = started.find((input) => input.task.title === 'Tarefa c')!;
    const plain = started.find((input) => input.task.title === 'Tarefa a')!;
    expect(boosted.limits.maxTokens).toBe(Math.min(10_000_000, defaultLimits.maxTokens * 2));
    expect(boosted.limits.maxSteps).toBe(Math.min(200, defaultLimits.maxSteps * 2));
    expect(plain.limits.maxTokens).toBe(defaultLimits.maxTokens);
    expect(boosted.worker.squad.every((soldier) => soldier.enabled)).toBe(true);
    expect(plain.worker.squad.find((soldier) => soldier.role === 'scout')?.enabled).toBe(false);

    // Honey changes how a task starts, so a running one cannot take it.
    expect(() => ctx.scheduler.boost('task_a', true)).toThrow(/ainda não começaram/);
    release();
    await until(() => ctx.status() === 'review', 'review');
  });

  it('aceita tarefas, dependências e delegações feitas à mão, com as mesmas regras do plano', async () => {
    const ctx = await setup(async () => ({}), [{ key: 'a' }, { key: 'b' }]);
    const added = ctx.scheduler.addTask(ctx.run.id, {
      key: 'c',
      title: 'Tarefa c',
      description: 'Criada no canvas',
      workerId: 'w1',
      dependsOn: ['a'],
      acceptanceCriteria: ['ok'],
    });
    expect(added).toMatchObject({ status: 'pending', dependsOn: ['a'], workerId: 'w1' });
    expect(() => ctx.scheduler.addTask(ctx.run.id, { ...added, key: 'c', dependsOn: [] })).toThrow(
      /Já existe/,
    );
    expect(() =>
      ctx.scheduler.addTask(ctx.run.id, { ...added, key: 'd', dependsOn: ['nada'] }),
    ).toThrow(/desconhecida/);

    // b → c, then c → b would close a loop.
    expect(ctx.scheduler.setDependency(added.id, 'task_b', true).dependsOn).toEqual(['a', 'b']);
    expect(() => ctx.scheduler.setDependency('task_b', added.id, true)).toThrow(/ciclo/);
    expect(ctx.scheduler.setDependency(added.id, 'task_a', false).dependsOn).toEqual(['b']);

    expect(ctx.scheduler.assign('task_a', 'w1').workerId).toBe('w1');
    ctx.repos.workers.put({ ...ctx.repos.workers.require('w1', 'Agente'), id: 'q', role: 'queen' });
    expect(() => ctx.scheduler.assign('task_a', 'q')).toThrow(/Queen/);

    // Once started, the plan of a task is no longer changed by hand.
    ctx.scheduler.start(ctx.run.id);
    await until(() => ctx.status() === 'review', 'review');
    expect(ctx.task('a').status).toBe('completed');
    expect(() => ctx.scheduler.setDependency('task_a', 'task_b', true)).toThrow(/não começou/);
    expect(() => ctx.scheduler.assign('task_a', 'w1')).toThrow(/não começou/);
    expect(ctx.repos.tasks.require(added.id, 'Tarefa').status).toBe('completed');
  });
});

describe('Scheduler com o Claude Code como motor', { timeout: 60_000 }, () => {
  it('a tarefa roda no adaptador, o trabalho vira commit e o resultado chega ao relatório', async () => {
    const { ClaudeCodeRuntime } = await import('@hive/agents');
    const { fileURLToPath } = await import('node:url');
    const fake = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../agents/src/fixtures/fake-claude-code.mjs',
    );
    const claude = new ClaudeCodeRuntime({ executable: process.execPath, argsPrefix: [fake] });
    const events: string[] = [];
    const ctx = await setup(async () => ({}), [{ key: 'a' }], false, {
      runtimeFor: () => claude,
    });
    const original = claude.subscribe.bind(claude);
    claude.subscribe = (id, listener) =>
      original(id, (event) => {
        events.push(event.type);
        listener(event);
      });
    ctx.scheduler.start(ctx.run.id);
    await until(() => ['review', 'failed'].includes(ctx.status()), 'fim da execução');

    const task = ctx.task('a');
    expect(task.error).toBeNull();
    expect(task.status).toBe('completed');
    expect(task.result?.summary).toBe('Criei hello.txt e rodei npm test.');
    expect(task.result?.filesChanged.map((file) => file.path)).toEqual(['hello.txt']);
    expect(task.result?.usage).toEqual({ promptTokens: 150, completionTokens: 40 });
    expect(task.result?.commands.map((command) => command.command)).toEqual(['npm test']);
    expect(events).toEqual(
      expect.arrayContaining(['session.started', 'file.changed', 'session.finished']),
    );
    const report = ctx.repos.runs.require(ctx.run.id, 'Execução').report ?? '';
    expect(report).toContain('Criei hello.txt e rodei npm test.');
  });
});

describe('Scheduler ao fechar o Hive', { timeout: 60_000 }, () => {
  it('shutdown interrompe as sessões em andamento no motor de cada uma', async () => {
    const cancelled: string[] = [];
    let finish = () => {};
    const stuck = new Promise<void>((resolve) => (finish = resolve));
    let started = false;
    const runtime = new FakeRuntime(async () => {
      started = true;
      await stuck;
      return { status: 'cancelled', error: 'Cancelada.' };
    });
    (runtime as AgentRuntime).cancel = async (sessionId: string) => {
      cancelled.push(sessionId);
      finish();
    };
    const ctx = await setup(async () => ({}), [{ key: 'a' }], false, { runtimeFor: () => runtime });
    ctx.scheduler.start(ctx.run.id);
    await until(() => started, 'motor iniciado');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ctx.scheduler.shutdown()).toBe(1);
    expect(cancelled).toEqual(['task_a-a1']);
    await until(() => !ctx.scheduler.isActive(ctx.run.id), 'a sessão terminar');
    // Nothing is closed half-way: the task and its worktree stay for the next start to resume.
    const task = ctx.task('a');
    expect(task.status).toBe('running');
    expect(task.worktreePath && existsSync(task.worktreePath)).toBe(true);
  });

  it('o Hive fecha no meio de uma tarefa; ao abrir, ela continua do trabalho já feito', async () => {
    let release = () => {};
    const hung = new Promise<void>((resolve) => (release = resolve));
    const ctx = await setup(
      async (input) => {
        await writeFile(path.join(input.worktreePath, 'parte1.txt'), 'um');
        await hung;
        return {};
      },
      [{ key: 'a' }, { key: 'b', dependsOn: ['a'] }],
    );
    ctx.scheduler.start(ctx.run.id);
    await until(() => {
      const worktree = ctx.task('a').worktreePath;
      return !!worktree && existsSync(path.join(worktree, 'parte1.txt'));
    }, 'a primeira parte do trabalho');
    const firstWorktree = ctx.task('a').worktreePath!;
    ctx.scheduler.shutdown();

    const seen: { description: string; hadPart1: boolean }[] = [];
    const reopened = ctx.reopen(async (input) => {
      if (input.task.title === 'Tarefa a') {
        seen.push({
          description: input.task.description,
          hadPart1: existsSync(path.join(input.worktreePath, 'parte1.txt')),
        });
        await writeFile(path.join(input.worktreePath, 'parte2.txt'), 'dois');
      } else await writeTaskFile(input);
      return {};
    });
    const resumed = await reopened.recover();
    expect(resumed.map((run) => run.id)).toEqual([ctx.run.id]);
    expect(existsSync(firstWorktree)).toBe(false);
    await until(() => ctx.status() === 'review', 'a missão terminar depois de reabrir');

    expect(seen).toHaveLength(1);
    expect(seen[0]!.hadPart1).toBe(true);
    expect(seen[0]!.description).toContain('interrompida');
    const a = ctx.task('a');
    expect(a.attempt).toBe(2);
    expect(a.checkpoint).toBeUndefined();
    // The review shows the whole task, both the interrupted part and the rest.
    expect(a.result?.filesChanged.map((file) => file.path).sort()).toEqual([
      'parte1.txt',
      'parte2.txt',
    ]);
    // The dependent task started from all of it.
    expect(ctx.task('b').status).toBe('completed');
    // Only the branches holding results are left: the checkpoint's was carried on and removed.
    const branches = ctx.git('branch', '--list', 'hive/*').trim().split('\n');
    expect(branches).toHaveLength(2);

    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('uma tarefa interrompida vezes demais para de ser retomada e espera o usuário', async () => {
    const ctx = await setup(async () => ({}), [{ key: 'a' }]);
    ctx.repos.runs.put({ ...ctx.run, status: 'running' });
    ctx.repos.tasks.put({
      ...ctx.task('a'),
      workerId: 'w1',
      status: 'running',
      attempt: 3,
      branch: 'hive/t/a-a3',
      startCommit: ctx.run.baseCommit,
      worktreePath: path.join(ctx.worktreeRoot, 'sumiu'),
      checkpoint: {
        commit: null,
        branch: null,
        startCommit: null,
        interruptions: 2,
        at: new Date().toISOString(),
      },
    });
    await ctx.scheduler.recover();
    const a = ctx.task('a');
    expect(a.status).toBe('failed');
    expect(a.error).toContain('Interrompida 3 vezes');
    expect(a.worktreePath).toBeNull();
    expect(ctx.status()).toBe('failed');
  });

  it('ao abrir: tarefa presa numa missão cancelada é encerrada e worktrees sem dono são removidas', async () => {
    const ctx = await setup(async () => ({}), [{ key: 'a' }]);
    ctx.repos.runs.put({ ...ctx.run, status: 'cancelled' });
    ctx.repos.tasks.put({ ...ctx.task('a'), workerId: 'w1', status: 'running' });
    const leftover = path.join(ctx.worktreeRoot, 'sobra-de-queda');
    await mkdir(leftover, { recursive: true });
    await writeFile(path.join(leftover, 'x.txt'), 'x');

    expect(await ctx.scheduler.recover()).toEqual([]);
    expect(ctx.task('a').status).toBe('cancelled');
    expect(existsSync(leftover)).toBe(false);
  });

  it('o erro da tentativa anterior chega à nova tentativa mesmo depois de reabrir', async () => {
    const descriptions: string[] = [];
    const ctx = await setup(
      async (input) => {
        descriptions.push(input.task.description);
        return {};
      },
      [{ key: 'a' }],
    );
    ctx.repos.runs.put({ ...ctx.run, status: 'running' });
    ctx.repos.tasks.put({
      ...ctx.task('a'),
      workerId: 'w1',
      attempt: 1,
      retryNote: 'npm test falhou: 2 testes',
    });
    await ctx.scheduler.recover();
    await until(() => ctx.status() !== 'running', 'a tarefa terminar');
    expect(descriptions[0]).toContain('npm test falhou: 2 testes');
    expect(ctx.task('a').retryNote).toBeUndefined();
  });
});

describe('Agente com motor Claude Code e aprovações do Hive', { timeout: 60_000 }, () => {
  it('o pedido de permissão do Claude Code vira aprovação do Hive', async () => {
    const { ClaudeCodePermissions, ClaudeCodeRuntime } = await import('@hive/agents');
    const { fileURLToPath } = await import('node:url');
    const fake = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../agents/src/fixtures/fake-claude-code.mjs',
    );
    const permissions = new ClaudeCodePermissions();
    const claude = new ClaudeCodeRuntime({
      executable: process.execPath,
      argsPrefix: [fake],
      permissions,
    });
    process.env.FAKE_CLAUDE_MODE = 'permission';
    try {
      const ctx = await setup(async () => ({}), [{ key: 'a' }], false, {
        // The service sends agents on the Claude Code provider to this engine.
        runtimeFor: () => claude,
      });

      ctx.scheduler.start(ctx.run.id);
      await until(
        () => ctx.repos.approvals.list("status = 'pending'").length === 1,
        'pedido de aprovação',
      );
      const [approval] = ctx.repos.approvals.list("status = 'pending'");
      expect(approval!.detail).toContain('npm test');
      ctx.scheduler.resolveApproval(approval!.id, true, false);
      await until(() => ['review', 'failed'].includes(ctx.status()), 'fim da execução');

      const task = ctx.task('a');
      expect(task.error).toBeNull();
      expect(JSON.parse(task.result!.summary).decision).toEqual({
        behavior: 'allow',
        updatedInput: { command: 'npm test' },
      });
    } finally {
      delete process.env.FAKE_CLAUDE_MODE;
      await permissions.close();
    }
  });
});

describe('Scheduler com várias tentativas', { timeout: 120_000 }, () => {
  const three = () => [
    { providerId: 'p1', modelId: 'm1' },
    { providerId: 'p1', modelId: 'm2' },
    { providerId: 'p1', modelId: 'm3' },
  ];
  const candidatesOf = (repos: Repositories, key: string) =>
    repos.tasks
      .list()
      .filter((task) => task.candidateOf?.parentTaskId === `task_${key}`)
      .sort((a, b) => a.key.localeCompare(b.key));
  const writeModelFile = (input: AgentTaskInput) =>
    writeFile(path.join(input.worktreePath, `${input.model}.txt`), input.model);

  it('roda uma tentativa por modelo e fica com a que passa nas verificações do projeto', async () => {
    const sawInB: string[] = [];
    const ctx = await setup(
      async (input) => {
        if (input.task.title === 'Tarefa b') {
          for (const model of ['m1', 'm2', 'm3'])
            if (existsSync(path.join(input.worktreePath, `${model}.txt`))) sawInB.push(model);
          await writeTaskFile(input);
        } else await writeModelFile(input);
        return {};
      },
      [{ key: 'a' }, { key: 'b', dependsOn: ['a'] }],
      false,
      {
        candidateModels: three,
        checkCandidate: async ({ task }) => [
          { command: 'npm test', ok: task.candidateOf?.modelId === 'm2' },
          { command: 'npm run lint', ok: true },
        ],
      },
    );
    ctx.scheduler.setBestOf('task_a', 3);
    ctx.scheduler.start(ctx.run.id);
    await until(() => ctx.status() === 'review', 'a missão chegar à revisão', 90_000).catch(
      (error: unknown) => {
        throw new Error(
          `${String(error)} ${JSON.stringify(ctx.repos.tasks.list().map((t) => [t.key, t.status, t.workerState, t.candidateOf?.outcome]))}`,
        );
      },
    );

    const a = ctx.task('a');
    const candidates = candidatesOf(ctx.repos, 'a');
    expect(candidates.map((task) => task.candidateOf?.modelId)).toEqual(['m1', 'm2', 'm3']);
    const winner = candidates.find((task) => task.candidateOf?.outcome === 'won')!;
    expect(winner.candidateOf?.modelId).toBe('m2');
    expect(candidates.filter((task) => task.candidateOf?.outcome === 'lost')).toHaveLength(2);
    expect(a.status).toBe('completed');
    expect(a.bestOf?.choice?.winnerTaskId).toBe(winner.id);
    expect(a.bestOf?.choice?.reason).toContain('passou em 2 de 2');
    expect(a.result?.filesChanged.map((file) => file.path)).toEqual(['m2.txt']);
    // What depended on the task started from the result that won, and only from it.
    expect(sawInB).toEqual(['m2']);
    // The losers' branches are gone: the winner's (now the task's) and b's are left.
    expect(ctx.git('branch', '--list', 'hive/*').trim().split('\n')).toHaveLength(2);

    await ctx.scheduler.approve('task_a');
    expect(await readFile(path.join(ctx.repo, 'm2.txt'), 'utf8')).toBe('m2');
  });

  it('quando nenhuma tentativa dá certo a tarefa falha com o resumo, e repetir abre outra rodada', async () => {
    let round = 1;
    const ctx = await setup(
      async (input) => {
        if (round === 1) return { status: 'failed', error: `quebrou em ${input.model}` };
        await writeModelFile(input);
        return {};
      },
      [{ key: 'a' }],
      false,
      { candidateModels: () => three().slice(0, 2) },
    );
    ctx.scheduler.setBestOf('task_a', 2);
    ctx.scheduler.start(ctx.run.id);
    await until(() => ctx.status() === 'failed', 'a missão falhar');
    expect(ctx.task('a').status).toBe('failed');
    expect(ctx.task('a').error).toContain('Nenhuma das 2 tentativas deu certo');
    expect(ctx.task('a').error).toContain('quebrou em m2');

    round = 2;
    ctx.scheduler.retry('task_a');
    await until(() => ctx.status() === 'review', 'a nova rodada terminar');
    expect(ctx.task('a').status).toBe('completed');
    expect(ctx.task('a').attempt).toBe(2);
    const candidates = candidatesOf(ctx.repos, 'a');
    expect(candidates).toHaveLength(4);
    expect(candidates.filter((task) => task.candidateOf?.round === 2)).toHaveLength(2);
    // With no checks, the first to finish with changes is kept.
    expect(ctx.task('a').bestOf?.choice?.reason).toContain('Sem verificações');
  });

  it('com um modelo só, a tarefa roda uma vez, como uma tarefa comum', async () => {
    const models: string[] = [];
    const ctx = await setup(
      async (input) => {
        models.push(input.model);
        await writeModelFile(input);
        return {};
      },
      [{ key: 'a' }],
      false,
      { candidateModels: () => [{ providerId: 'p1', modelId: 'm1' }] },
    );
    ctx.scheduler.setBestOf('task_a', 3);
    ctx.scheduler.start(ctx.run.id);
    await until(() => ctx.status() === 'review', 'a missão chegar à revisão');
    expect(models).toEqual(['m1']);
    expect(candidatesOf(ctx.repos, 'a')).toHaveLength(0);
    expect(ctx.task('a').status).toBe('completed');
  });

  it('cancelar a tarefa para todas as tentativas', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = 0;
    const ctx = await setup(
      async () => {
        started++;
        await gate;
        return { status: 'cancelled', error: 'Cancelada.' };
      },
      [{ key: 'a' }],
      false,
      { candidateModels: () => three().slice(0, 2) },
    );
    ctx.scheduler.setBestOf('task_a', 2);
    ctx.scheduler.start(ctx.run.id);
    await until(() => started === 2, 'as duas tentativas começarem');
    ctx.scheduler.cancelTask('task_a');
    release();
    await until(
      () => ctx.status() !== 'running' && !ctx.scheduler.isActive(ctx.run.id),
      'a missão parar',
    );
    expect(ctx.task('a').status).toBe('cancelled');
    expect(candidatesOf(ctx.repos, 'a').every((task) => task.candidateOf?.outcome === 'lost')).toBe(
      true,
    );
  });

  it('o Hive fecha no meio da rodada; ao abrir, as mesmas tentativas continuam e uma é escolhida', async () => {
    let release = () => {};
    const hung = new Promise<void>((resolve) => (release = resolve));
    let started = 0;
    const ctx = await setup(
      async () => {
        started++;
        await hung;
        return {};
      },
      [{ key: 'a' }],
      false,
      { candidateModels: () => three().slice(0, 2) },
    );
    ctx.scheduler.setBestOf('task_a', 2);
    ctx.scheduler.start(ctx.run.id);
    await until(() => started === 2, 'as duas tentativas começarem');
    ctx.scheduler.shutdown();

    const reopened = ctx.reopen(async (input) => {
      await writeModelFile(input);
      return {};
    });
    await reopened.recover();
    await until(() => ctx.status() === 'review', 'a rodada terminar depois de reabrir');
    // The round that was going was picked up: no new candidates, one of them chosen.
    expect(candidatesOf(ctx.repos, 'a')).toHaveLength(2);
    expect(ctx.task('a').status).toBe('completed');
    expect(ctx.task('a').bestOf?.choice?.winnerTaskId).toBeTruthy();

    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
