import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultLimits,
  emptyCanvasLayout,
  failureSignature,
  type NexusAutopilotRecoveryDraft,
  type Task,
  type Worker,
} from '@hive/core';
import { HiveDatabase, Repositories } from '@hive/persistence';
import type { ChatClient } from '@hive/providers';
import { NexusAutopilot } from './nexus-autopilot';

const databases: HiveDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const at = new Date().toISOString();

function worker(id: string, role: Worker['role']): Worker {
  return {
    id,
    name: role === 'queen' ? 'Queen' : 'Backend',
    role,
    beeColor: null,
    squad: [],
    description: '',
    providerId: 'provider',
    modelId: 'model',
    skills: [],
    tools: [],
    autoApproveCommands: [],
    mcpServers: [],
    systemPrompt: '',
    limits: defaultLimits,
    createdAt: at,
    updatedAt: at,
  };
}

function task(key: string, patch: Partial<Task> = {}): Task {
  return {
    id: `task_${key}`,
    runId: 'run',
    key,
    title: `Tarefa ${key}`,
    description: 'd',
    workerId: 'backend',
    dependsOn: [],
    acceptanceCriteria: ['ok'],
    status: 'pending',
    workerState: 'idle',
    attempt: 1,
    branch: null,
    startCommit: null,
    worktreePath: null,
    result: null,
    error: null,
    createdAt: at,
    startedAt: null,
    finishedAt: null,
    ...patch,
  };
}

const replacement: NexusAutopilotRecoveryDraft = {
  strategy: 'split',
  diagnosis: 'O módulo de sessão não existe ainda.',
  rationale: 'Criar a sessão primeiro e depois a API em cima dela.',
  agents: [{ source: 'existing', key: 'backend', workerId: 'backend' }],
  tasks: [
    {
      key: 'sessao',
      title: 'Criar módulo de sessão',
      description: 'Sessão com expiração.',
      workerKey: 'backend',
      dependsOn: ['schema'],
      acceptanceCriteria: ['Testes de sessão passam.'],
    },
    {
      key: 'api-v2',
      title: 'API sobre a sessão',
      description: 'Endpoints usando o módulo novo.',
      workerKey: 'backend',
      dependsOn: ['sessao'],
      acceptanceCriteria: ['Testes da API passam.'],
    },
  ],
  resumeFrom: ['api-v2'],
  warnings: [],
};

async function until(check: () => boolean, what: string) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 5_000) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function setup(answer: () => unknown = () => replacement) {
  const db = new HiveDatabase(':memory:');
  databases.push(db);
  const repos = new Repositories(db);
  repos.workspaces.put({
    id: 'ws',
    name: 'Projeto',
    path: '/tmp/projeto',
    defaultBranch: 'main',
    createdAt: at,
    lastOpenedAt: at,
  });
  repos.providers.put({
    id: 'provider',
    kind: 'openai-compatible',
    name: 'Local',
    baseUrl: 'http://127.0.0.1:1/v1',
    enabled: true,
    hasCredential: false,
    credentialHint: null,
    lastTest: null,
    modelsFetchedAt: null,
    createdAt: at,
  });
  repos.workers.put(worker('queen', 'queen'));
  repos.workers.put(worker('backend', 'backend'));
  repos.missions.put({
    id: 'mission',
    workspaceId: 'ws',
    title: 'Autenticação',
    objective: 'Login seguro',
    createdAt: at,
  });
  repos.runs.put({
    id: 'run',
    missionId: 'mission',
    workspaceId: 'ws',
    status: 'running',
    baseBranch: 'main',
    baseCommit: 'abc',
    queenWorkerId: 'queen',
    planNotes: null,
    report: null,
    error: null,
    createdAt: at,
    finishedAt: null,
  });
  repos.tasks.put(task('schema', { status: 'completed' }));
  repos.tasks.put(
    task('api', { status: 'failed', error: 'Cannot find module ./session at line 42' }),
  );
  repos.tasks.put(task('review', { dependsOn: ['api'] }));
  const chat = vi.fn<ChatClient['chat']>(async () => ({
    message: { role: 'assistant', content: JSON.stringify(answer()) },
    reasoning: null,
    finishReason: 'stop',
    usage: { promptTokens: 80, completionTokens: 40 },
    latencyMs: 1,
  }));
  // Stands in for the scheduler: the same effect on the tasks, without running agents.
  const reroute = vi.fn((taskId: string, keys: string[], note: string) => {
    const failed = repos.tasks.require(taskId, 'Tarefa');
    for (const item of repos.tasks.list('run_id = ?', 'run'))
      if (item.dependsOn.includes(failed.key))
        repos.tasks.put({
          ...item,
          dependsOn: [...item.dependsOn.filter((key) => key !== failed.key), ...keys],
        });
    repos.tasks.put({ ...failed, status: 'rejected', error: note });
  });
  const refresh = vi.fn();
  const engine = new NexusAutopilot({
    repos,
    layout: () => emptyCanvasLayout,
    chatFor: () => ({ chat }),
    invoke: async (channel, input) => {
      if (channel === 'canvas.task.create') {
        const { task: plan } = input as { task: Omit<Task, 'id'> & { key: string } };
        return repos.tasks.put(task(plan.key, { ...plan, status: 'pending', attempt: 0 }));
      }
      return undefined;
    },
    resultContext: () => '',
    onEvent: () => undefined,
    reroute,
    refresh,
  });
  const run = () => repos.runs.require('run', 'Execução');
  const records = () => repos.nexusAutopilotRecoveries.list('run_id = ?', 'run');
  const latest = () =>
    records().sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    )[0]!;
  const fail = (key: string, error: string) => {
    const failed = repos.tasks.put({
      ...repos.tasks.require(`task_${key}`, 'Tarefa'),
      status: 'failed',
      error,
    });
    engine.detect(run(), failed);
    return failed;
  };
  const limits = (patch: Partial<ReturnType<typeof repos.getSettings>['replanning']>) =>
    repos.saveSettings({
      ...repos.getSettings(),
      replanning: { ...repos.getSettings().replanning, ...patch },
    });
  return { repos, engine, chat, reroute, refresh, run, records, latest, fail, limits };
}

describe('Replanejamento adaptativo', () => {
  it('segura o ramo na hora e traz uma sugestão estruturada da Queen', async () => {
    const ctx = setup();
    const api = ctx.repos.tasks.require('task_api', 'Tarefa');
    ctx.engine.detect(ctx.run(), api);
    // Held before the Queen answers, so the scheduler never cancels the dependents.
    expect(ctx.engine.holds(api)).toBe(true);
    expect(ctx.latest()).toMatchObject({ state: 'proposing', dependents: ['review'] });

    await until(() => ctx.latest().state === 'proposed', 'proposta');
    const [recovery] = ctx.engine.recoveries('run');
    expect(recovery?.draft?.strategy).toBe('split');
    expect(recovery?.usage).toEqual({ promptTokens: 80, completionTokens: 40 });
    expect(ctx.chat).toHaveBeenCalledTimes(1);
    const prompt = JSON.parse(String(ctx.chat.mock.calls[0]![0].messages[1]!.content));
    expect(prompt.failure).toMatchObject({ key: 'api', error: expect.stringContaining('session') });
    expect(prompt.waitingTasks).toEqual([{ key: 'review', title: 'Tarefa review' }]);
  });

  it('aplica o patch pelo motor e religa as tarefas que esperavam', async () => {
    const ctx = setup();
    ctx.fail('api', 'Cannot find module ./session at line 42');
    await until(() => ctx.latest().state === 'proposed', 'proposta');

    const applied = await ctx.engine.applyRecovery('run', ctx.latest().id);
    expect(applied.state).toBe('applied');
    expect(Object.keys(applied.applied!.taskIds)).toEqual(['sessao', 'api-v2']);
    expect(ctx.reroute).toHaveBeenCalledWith(
      'task_api',
      ['api-v2'],
      expect.stringContaining('deu lugar a api-v2'),
    );
    expect(ctx.repos.tasks.require('task_review', 'Tarefa').dependsOn).toEqual(['api-v2']);
    expect(ctx.engine.recoveries('run')).toEqual([]);
    // Applying again is a no-op that returns the receipt.
    expect((await ctx.engine.applyRecovery('run', applied.id)).state).toBe('applied');
    expect(ctx.reroute).toHaveBeenCalledTimes(1);
  });

  it('pular a tarefa libera as que esperavam sem criar nada', async () => {
    const ctx = setup(() => ({
      ...replacement,
      strategy: 'skip',
      agents: [],
      tasks: [],
      resumeFrom: [],
    }));
    ctx.fail('api', 'boom');
    await until(() => ctx.latest().state === 'proposed', 'proposta');
    await ctx.engine.applyRecovery('run', ctx.latest().id);
    expect(ctx.reroute).toHaveBeenCalledWith('task_api', [], expect.stringContaining('pulada'));
    expect(ctx.repos.tasks.require('task_review', 'Tarefa').dependsOn).toEqual([]);
  });

  it('rejeita patch que depende do ramo em espera e mantém o ramo segurado', async () => {
    const ctx = setup(() => ({
      ...replacement,
      tasks: [{ ...replacement.tasks[1]!, dependsOn: ['review'] }],
    }));
    const api = ctx.fail('api', 'boom');
    await until(() => ctx.latest().state === 'failed', 'falha da proposta');
    expect(ctx.latest().reason).toContain('espera a tarefa que falhou');
    expect(ctx.engine.holds(api)).toBe(true);
    await expect(ctx.engine.applyRecovery('run', ctx.latest().id)).rejects.toThrow(
      'não está mais disponível',
    );
  });

  it('para de propor quando o mesmo erro volta depois de um replanejamento', async () => {
    const ctx = setup();
    ctx.fail('api', 'Cannot find module ./session at line 42');
    await until(() => ctx.latest().state === 'proposed', 'proposta');
    await ctx.engine.applyRecovery('run', ctx.latest().id);

    // The replacement fails the same way, with another line number.
    const replaced = ctx.fail('api-v2', 'Cannot find module ./session at line 57');
    expect(ctx.latest()).toMatchObject({
      state: 'exhausted',
      rootTaskKey: 'api',
      attempt: 2,
    });
    expect(ctx.latest().reason).toContain('mesmo erro');
    expect(ctx.engine.holds(replaced)).toBe(true);
    expect(ctx.chat).toHaveBeenCalledTimes(1);
    expect(() => ctx.engine.retryRecovery('run', ctx.latest().id)).toThrow('limite');
  });

  it('respeita o limite por tarefa, contando a substituta da substituta', async () => {
    const ctx = setup();
    ctx.limits({ maxPerTask: 1 });
    ctx.fail('api', 'boom');
    await until(() => ctx.latest().state === 'proposed', 'proposta');
    await ctx.engine.applyRecovery('run', ctx.latest().id);
    ctx.fail('api-v2', 'outro erro completamente diferente');
    expect(ctx.latest().state).toBe('exhausted');
    expect(ctx.latest().reason).toContain('Limite de 1 replanejamento(s) para “api”');
  });

  it('respeita o limite de sugestões por missão, inclusive ao pedir outra', async () => {
    const ctx = setup();
    ctx.limits({ maxPerRun: 1 });
    ctx.repos.tasks.put(task('docs', { status: 'pending' }));
    ctx.fail('api', 'boom');
    await until(() => ctx.latest().state === 'proposed', 'proposta');
    expect(() => ctx.engine.retryRecovery('run', ctx.latest().id)).toThrow(
      'Limite de 1 replanejamentos por missão',
    );
    ctx.fail('docs', 'outro');
    expect(ctx.latest()).toMatchObject({ taskKey: 'docs', state: 'exhausted' });
    expect(ctx.chat).toHaveBeenCalledTimes(1);
  });

  it('pedir outra sugestão substitui a anterior e consulta a Queen de novo', async () => {
    const ctx = setup();
    ctx.fail('api', 'boom');
    await until(() => ctx.latest().state === 'proposed', 'proposta');
    const first = ctx.latest();
    const next = ctx.engine.retryRecovery('run', first.id);
    expect(ctx.repos.nexusAutopilotRecoveries.require(first.id, 'x').state).toBe('superseded');
    await until(
      () => ctx.repos.nexusAutopilotRecoveries.require(next.id, 'x').state === 'proposed',
      'nova proposta',
    );
    expect(ctx.chat).toHaveBeenCalledTimes(2);
    expect(ctx.engine.recoveries('run').map((item) => item.id)).toEqual([next.id]);
  });

  it('encerrar o ramo solta o ramo e pede ao motor para olhar de novo', async () => {
    const ctx = setup();
    const api = ctx.fail('api', 'boom');
    await until(() => ctx.latest().state === 'proposed', 'proposta');
    const dismissed = ctx.engine.dismissRecovery('run', ctx.latest().id);
    expect(dismissed.state).toBe('dismissed');
    expect(ctx.engine.holds(api)).toBe(false);
    expect(ctx.refresh).toHaveBeenCalledWith('run');
    expect(ctx.engine.recoveries('run')).toEqual([]);
  });

  it('desligado, não segura nada nem consulta a Queen', () => {
    const ctx = setup();
    ctx.limits({ enabled: false });
    const api = ctx.fail('api', 'boom');
    expect(ctx.records()).toEqual([]);
    expect(ctx.engine.holds(api)).toBe(false);
    expect(ctx.chat).not.toHaveBeenCalled();
  });

  it('não aplica quando a missão já não está em execução', async () => {
    const ctx = setup();
    ctx.fail('api', 'boom');
    await until(() => ctx.latest().state === 'proposed', 'proposta');
    ctx.repos.runs.put({ ...ctx.run(), status: 'cancelled' });
    await expect(ctx.engine.applyRecovery('run', ctx.latest().id)).rejects.toThrow(
      'não está mais em execução',
    );
    expect(ctx.reroute).not.toHaveBeenCalled();
  });
});

describe('failureSignature', () => {
  it('ignora números, ids e caminhos para reconhecer o mesmo erro', () => {
    expect(failureSignature('Error at C:\\tmp\\a1\\x.ts:42 (commit 9f3a2b1c)')).toBe(
      failureSignature('Error at C:\\tmp\\b7\\x.ts:57 (commit 0d1e2f3a)'),
    );
    expect(failureSignature('Timeout after 3000ms in src/a/b.ts')).toBe(
      failureSignature('Timeout after 5000ms in src/c/d.ts'),
    );
    expect(failureSignature('Cannot find module x')).not.toBe(failureSignature('Type error'));
  });
});
