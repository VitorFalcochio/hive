import { afterEach, describe, expect, it } from 'vitest';
import { HiveDatabase, Repositories } from '@hive/persistence';
import { canvasChannels, type Task } from '@hive/core';
import { canvasRuns, canvasSnapshot } from './canvas-data';

const databases: HiveDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const at = '2026-10-29T10:00:00.000Z';

function seed() {
  const db = new HiveDatabase(':memory:');
  databases.push(db);
  const repos = new Repositories(db);
  repos.workspaces.put({
    id: 'ws1',
    name: 'loja',
    path: '/tmp/loja',
    defaultBranch: 'main',
    createdAt: at,
    lastOpenedAt: at,
  });
  repos.providers.put({
    id: 'p1',
    kind: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    enabled: true,
    hasCredential: true,
    credentialHint: null,
    lastTest: null,
    modelsFetchedAt: null,
    createdAt: at,
  });
  const worker = (id: string, role: 'queen' | 'backend' | 'qa', modelId: string | null) =>
    repos.workers.put({
      id,
      name: id,
      role,
      beeColor: null,
      squad: [],
      description: '',
      providerId: 'p1',
      modelId,
      skills: [],
      tools: [],
      mcpServers: [],
      autoApproveCommands: [],
      systemPrompt: 'segredo do prompt',
      limits: {
        maxSteps: 10,
        maxTokens: 10_000,
        commandTimeoutSec: 60,
        taskTimeoutMin: 10,
        temperature: null,
      },
      createdAt: at,
      updatedAt: at,
    });
  worker('queen', 'queen', 'q-model');
  worker('back', 'backend', 'b-model');
  worker('unused', 'qa', null);
  repos.putModel({
    id: 'b-model',
    providerId: 'p1',
    displayName: 'B',
    family: null,
    contextWindow: null,
    capabilities: { tools: 'yes', structuredOutput: 'unknown', reasoning: 'unknown', vision: 'no' },
    capabilitySource: 'unverified',
    pricing: { inputPerMTok: 1, outputPerMTok: 2 },
  });
  repos.missions.put({
    id: 'm1',
    workspaceId: 'ws1',
    title: 'Checkout',
    objective: 'Pagamento',
    createdAt: at,
  });
  const run = (id: string, status: 'running' | 'review', createdAt: string) =>
    repos.runs.put({
      id,
      missionId: 'm1',
      workspaceId: 'ws1',
      status,
      baseBranch: 'main',
      baseCommit: 'abc123',
      queenWorkerId: 'queen',
      planNotes: null,
      report: null,
      error: null,
      createdAt,
      finishedAt: null,
    });
  run('old', 'review', '2026-10-28T10:00:00.000Z');
  run('r1', 'running', '2026-10-27T10:00:00.000Z');
  const task = (id: string, patch: Partial<Task>): Task =>
    repos.tasks.put({
      id,
      runId: 'r1',
      key: id,
      title: id,
      description: '',
      workerId: 'back',
      dependsOn: [],
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
      ...patch,
    });
  task('api', {
    status: 'completed',
    result: {
      summary: 'feito',
      filesChanged: [{ path: 'api.ts', status: 'M' }],
      insertions: 3,
      deletions: 1,
      commit: 'def',
      commands: [],
      usage: { promptTokens: 1_000_000, completionTokens: 500_000 },
    },
  });
  task('ui', { status: 'running', workerState: 'coding', dependsOn: ['api'] });
  repos.appendEvent({
    id: 'e1',
    ts: at,
    workspaceId: 'ws1',
    runId: 'r1',
    taskId: 'api',
    workerId: 'back',
    type: 'session.started',
    level: 'info',
    message: 'back started on b-model',
    data: { model: 'b-model' },
  });
  return repos;
}

describe('dados do Nexus', () => {
  it('lista primeiro as missões em andamento, com a contagem real das tarefas', () => {
    const runs = canvasRuns(seed());
    expect(runs.map((run) => run.runId)).toEqual(['r1', 'old']);
    expect(runs[0]).toMatchObject({
      missionTitle: 'Checkout',
      workspaceName: 'loja',
      tasks: { total: 2, done: 1, running: 1, failed: 0 },
    });
  });

  it('monta o snapshot com a equipe sem segredos e o custo do modelo que trabalhou', () => {
    const repos = seed();
    const detail = {
      run: repos.runs.require('r1', 'run'),
      mission: repos.missions.require('m1', 'missão'),
      tasks: repos.tasks.list('run_id = ?', 'r1'),
      approvals: [],
    };
    const snapshot = canvasSnapshot(repos, detail, {
      planning: false,
      queue: ['x', 'r1'],
      terminals: [],
    });
    // The whole team, for the pickers and agents placed by hand on the canvas.
    expect(snapshot.workers.map((worker) => worker.id).sort()).toEqual(['back', 'queen', 'unused']);
    expect(snapshot.workers.find((worker) => worker.id === 'back')).toEqual({
      id: 'back',
      name: 'back',
      role: 'backend',
      beeColor: null,
      providerId: 'p1',
      providerName: 'OpenRouter',
      modelId: 'b-model',
    });
    // Prompts and limits stay out of the window.
    expect(JSON.stringify(snapshot.workers)).not.toContain('segredo');
    expect(snapshot.usage.api).toEqual({
      promptTokens: 1_000_000,
      completionTokens: 500_000,
      costUsd: 2,
    });
    expect(snapshot.usage.ui).toBeUndefined();
    expect(snapshot.queuePosition).toBe(1);
    expect(snapshot.workspace).toEqual({ id: 'ws1', name: 'loja' });
  });

  it('deixa o custo desconhecido quando não há registro do modelo usado', () => {
    const repos = seed();
    repos.tasks.put({ ...repos.tasks.require('api', 'tarefa'), id: 'other', key: 'other' });
    const detail = {
      run: repos.runs.require('r1', 'run'),
      mission: repos.missions.require('m1', 'missão'),
      tasks: repos.tasks.list('run_id = ?', 'r1'),
      approvals: [],
    };
    const snapshot = canvasSnapshot(repos, detail, { planning: false, queue: [], terminals: [] });
    expect(snapshot.usage.other?.costUsd).toBeNull();
    expect(snapshot.queuePosition).toBeNull();
  });

  it('a janela do canvas não alcança configurações, arquivos, terminais nem chaves', () => {
    for (const channel of [
      'settings.get',
      'settings.update',
      'provider.setKey',
      'fs.write',
      'fs.read',
      'terminal.start',
      'worker.save',
      'task.approve',
      'run.setPlan',
      'window.openCanvas',
    ] as const)
      expect(canvasChannels.has(channel)).toBe(false);
    expect(canvasChannels.has('canvas.snapshot')).toBe(true);
    expect(canvasChannels.has('task.retry')).toBe(true);
  });
});

describe('Hive Teams no Nexus', () => {
  it('mostra os agentes da equipe desta missão, quem os lidera e a conversa, sem segredos', async () => {
    const { secretRedactor } = await import('@hive/shared');
    const repos = seed();
    const base = repos.workers.require('back', 'agente');
    const team = (id: string, runId: string) =>
      repos.workers.put({
        ...base,
        id,
        name: id,
        team: {
          runId,
          parentAgentId: 'back',
          createdByAgentId: 'back',
          spawnRequestId: `req-${id}`,
          depth: 1,
        },
      });
    team('codex', 'r1');
    team('outra-missao', 'old');
    const secret = 'sk-SegredoQueVazou123456';
    secretRedactor.register(secret);
    try {
      repos.teamMessages.insertOnce({
        id: 'tm1',
        runId: 'r1',
        idempotencyKey: 'k1',
        kind: 'feedback',
        fromAgentId: 'codex',
        toAgentId: 'back',
        fromTaskId: 'ui',
        toTaskId: 'api',
        subject: 'Mudanças pedidas',
        body: `Use a chave ${secret} ${'x'.repeat(900)}`,
        payload: { verdict: 'changes_requested', comments: [{ path: 'a.ts' }] },
        createdAt: at,
      });
      const snapshot = canvasSnapshot(
        repos,
        {
          run: repos.runs.require('r1', 'run'),
          mission: repos.missions.require('m1', 'missão'),
          tasks: repos.tasks.list('run_id = ?', 'r1'),
          approvals: [],
        },
        { planning: false, queue: [], terminals: [] },
      );
      const ids = snapshot.workers.map((worker) => worker.id);
      expect(ids).toContain('codex');
      expect(ids).not.toContain('outra-missao');
      expect(snapshot.workers.find((worker) => worker.id === 'codex')!.team).toEqual({
        parentAgentId: 'back',
        createdByAgentId: 'back',
        depth: 1,
      });
      const [message] = snapshot.teamMessages!;
      expect(message).toMatchObject({
        kind: 'feedback',
        verdict: 'changes_requested',
        fromAgentId: 'codex',
      });
      expect(message!.body).not.toContain(secret);
      expect(message!.body.length).toBeLessThanOrEqual(601);
      expect(JSON.stringify(snapshot)).not.toContain('comments');
    } finally {
      secretRedactor.unregister(secret);
    }
  });

  it('sem equipe, o snapshot fica como antes', () => {
    const repos = seed();
    const snapshot = canvasSnapshot(
      repos,
      {
        run: repos.runs.require('r1', 'run'),
        mission: repos.missions.require('m1', 'missão'),
        tasks: repos.tasks.list('run_id = ?', 'r1'),
        approvals: [],
      },
      { planning: false, queue: [], terminals: [] },
    );
    expect('teamMessages' in snapshot).toBe(false);
    expect(snapshot.workers.every((worker) => !('team' in worker))).toBe(true);
  });
});
