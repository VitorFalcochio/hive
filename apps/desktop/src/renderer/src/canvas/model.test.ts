import { describe, expect, it } from 'vitest';
import type { AgentEvent, CanvasSnapshot, CanvasWorker, Task } from '@hive/core';
import {
  UNASSIGNED,
  activeAgents,
  agentStatus,
  buildGraph,
  changedFiles,
  nodeId,
  runElapsedMs,
  taskTone,
  terminalEntries,
  testRuns,
} from './model';

const at = '2026-10-29T10:00:00.000Z';

function task(key: string, patch: Partial<Task> = {}): Task {
  return {
    id: key,
    runId: 'r1',
    key,
    title: key,
    description: '',
    workerId: null,
    dependsOn: [],
    acceptanceCriteria: [],
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
  };
}

const worker = (id: string, role: CanvasWorker['role']): CanvasWorker => ({
  id,
  name: id,
  role,
  beeColor: null,
  providerId: 'p1',
  providerName: 'Provedor',
  modelId: 'modelo',
});

function snapshot(tasks: Task[], patch: Partial<CanvasSnapshot> = {}): CanvasSnapshot {
  return {
    detail: {
      run: {
        id: 'r1',
        missionId: 'm1',
        workspaceId: 'ws1',
        status: 'running',
        baseBranch: 'main',
        baseCommit: 'abc',
        queenWorkerId: 'queen',
        planNotes: null,
        report: null,
        error: null,
        createdAt: at,
        finishedAt: null,
      },
      mission: { id: 'm1', workspaceId: 'ws1', title: 'Missão', objective: 'x', createdAt: at },
      tasks,
      approvals: [],
    },
    workspace: { id: 'ws1', name: 'loja' },
    workers: [worker('queen', 'queen'), worker('back', 'backend'), worker('front', 'frontend')],
    usage: {},
    planning: false,
    queuePosition: null,
    terminals: [],
    at,
    ...patch,
  };
}

const event = (patch: Partial<AgentEvent>): AgentEvent => ({
  id: Math.random().toString(36),
  ts: at,
  workspaceId: 'ws1',
  runId: 'r1',
  taskId: null,
  workerId: null,
  type: 'info',
  level: 'info',
  message: '',
  data: null,
  ...patch,
});

const plan = () => [
  task('db', { workerId: 'back', status: 'completed' }),
  task('api', { workerId: 'back', dependsOn: ['db'], status: 'running', workerState: 'coding' }),
  task('ui', { workerId: 'front', dependsOn: ['api'] }),
  task('docs'),
];

describe('estados das tarefas', () => {
  it('distingue concluída, executando, aguardando, falha, bloqueio e fila', () => {
    expect(taskTone(task('a', { status: 'approved' }))).toBe('done');
    expect(taskTone(task('a', { status: 'running', workerState: 'testing' }))).toBe('running');
    expect(taskTone(task('a', { status: 'running', workerState: 'waiting_provider' }))).toBe(
      'waiting',
    );
    expect(taskTone(task('a', { status: 'waiting_approval' }))).toBe('waiting');
    expect(taskTone(task('a', { status: 'failed' }))).toBe('failed');
    expect(
      taskTone(task('a', { status: 'cancelled', error: 'Dependência não concluída: db' })),
    ).toBe('failed');
    expect(taskTone(task('a', { status: 'cancelled', error: 'Cancelada.' }))).toBe('muted');
    expect(taskTone(task('a'))).toBe('pending');
  });

  it('o estado de um agente vem da tarefa em que ele está agora', () => {
    const snap = snapshot(plan(), {
      usage: { db: { promptTokens: 100, completionTokens: 50, costUsd: 0.5 } },
    });
    const back = agentStatus(worker('back', 'backend'), snap);
    expect(back).toMatchObject({ state: 'coding', tone: 'running', done: 1, promptTokens: 100 });
    expect(back.current?.key).toBe('api');
    expect(back.costUsd).toBe(0.5);
    expect(agentStatus(worker('front', 'frontend'), snap).state).toBe('idle');
    expect(agentStatus(worker('queen', 'queen'), snap).state).toBe('completed');
    expect(agentStatus(worker('queen', 'queen'), snapshot([], { planning: true })).state).toBe(
      'planning',
    );
    expect(activeAgents(snap)).toBe(1);
  });
});

describe('grafo da missão', () => {
  it('agrupado por agente: uma raia por agente, a Queen coordena, dependências entre raias', () => {
    const { nodes, edges } = buildGraph(snapshot(plan()), {
      grouping: 'agent',
      collapsed: new Set(),
    });
    const lanes = nodes.filter((node) => node.type === 'lane').map((node) => node.ref);
    // Lanes follow the flow: by the first dependency column they work in.
    expect(lanes).toEqual(['back', UNASSIGNED, 'front']);
    const api = nodes.find((node) => node.id === nodeId.task('api'))!;
    expect(api.parentId).toBe(nodeId.group('back'));
    // `api` sits one dependency column to the right of `db`.
    const db = nodes.find((node) => node.id === nodeId.task('db'))!;
    expect(api.position.x).toBeGreaterThan(db.position.x);
    const dependency = edges.find(
      (edge) => edge.kind === 'dependency' && edge.target === nodeId.task('api'),
    );
    expect(dependency).toMatchObject({ source: nodeId.task('db'), tone: 'done', active: true });
    expect(edges.filter((edge) => edge.kind === 'coordination').map((edge) => edge.target)).toEqual(
      [nodeId.agent('back'), nodeId.task('docs'), nodeId.agent('front')],
    );
    expect(
      edges.filter((edge) => edge.kind === 'assignment' && edge.source === nodeId.agent('back')),
    ).toHaveLength(2);
  });

  it('um grupo recolhido esconde as tarefas e leva as dependências para o agente', () => {
    const { nodes, edges } = buildGraph(snapshot(plan()), {
      grouping: 'agent',
      collapsed: new Set(['back']),
    });
    expect(nodes.some((node) => node.id === nodeId.task('api'))).toBe(false);
    const folded = edges.find(
      (edge) => edge.kind === 'dependency' && edge.target === nodeId.task('ui'),
    );
    expect(folded).toMatchObject({ source: nodeId.agent('back'), folded: true });
    // db → api happened inside the folded lane: no line from the agent to itself.
    expect(edges.some((edge) => edge.source === edge.target)).toBe(false);
  });

  it('em fluxo: só tarefas em colunas de dependência, sem nós de agente além da Queen', () => {
    const { nodes, edges } = buildGraph(snapshot(plan()), {
      grouping: 'none',
      collapsed: new Set(),
    });
    expect(nodes.filter((node) => node.type === 'agent').map((node) => node.ref)).toEqual([
      'queen',
    ]);
    expect(nodes.filter((node) => node.type === 'task')).toHaveLength(4);
    expect(edges.filter((edge) => edge.kind === 'dependency')).toHaveLength(2);
    const x = (key: string) => nodes.find((node) => node.id === nodeId.task(key))!.position.x;
    expect(x('db')).toBeLessThan(x('api'));
    expect(x('api')).toBeLessThan(x('ui'));
  });

  it('a ordem não muda quando o repositório devolve as tarefas em outra ordem', () => {
    const first = buildGraph(snapshot(plan()), { grouping: 'agent', collapsed: new Set() });
    const again = buildGraph(snapshot([...plan()].reverse()), {
      grouping: 'agent',
      collapsed: new Set(),
    });
    expect(again.nodes).toEqual(first.nodes);
  });
});

it('posiciona Resultado Vivo à direita e só cria conexões de agregação informativas', () => {
  const snap = snapshot(plan());
  for (const grouping of ['workspace', 'agent', 'none'] as const) {
    const graph = buildGraph(snap, { grouping, collapsed: new Set() });
    const result = graph.nodes.find((node) => node.type === 'result')!;
    expect(result.id).toBe('result:m1');
    expect(result.width).toBeLessThan(400);
    for (const node of graph.nodes.filter((node) => !node.parentId && node.type !== 'result'))
      expect(result.position.x).toBeGreaterThan(node.position.x + node.width);
    expect(
      graph.edges
        .filter((edge) => edge.target === result.id)
        .every((edge) => edge.kind === 'aggregation' && !edge.active),
    ).toBe(true);
    expect(graph.edges.filter((edge) => edge.kind === 'dependency')).toHaveLength(2);
  }
  expect(snap.detail.tasks).toEqual(plan());
  for (const grouping of ['workspace', 'agent', 'none'] as const) {
    const graph = buildGraph(snapshot([task('unassigned')]), {
      grouping,
      collapsed: new Set([UNASSIGNED]),
    });
    expect(graph.edges.some((edge) => edge.kind === 'aggregation')).toBe(true);
  }
});

describe('console de execução', () => {
  const done = task('db', {
    status: 'completed',
    result: {
      summary: '',
      filesChanged: [{ path: 'db.ts', status: 'A' }],
      insertions: 1,
      deletions: 0,
      commit: 'c1',
      commands: [
        {
          command: 'npm test',
          exitCode: 1,
          durationMs: 900,
          timedOut: false,
          outputTail: 'falhou',
        },
        { command: 'ls', exitCode: 0, durationMs: 5, timedOut: false, outputTail: '' },
      ],
      usage: { promptTokens: 1, completionTokens: 1 },
    },
  });
  const running = task('api', { status: 'running' });
  const events = [
    event({ taskId: 'db', type: 'command.finished', data: { command: 'npm test', exitCode: 1 } }),
    event({ id: 's', taskId: 'api', type: 'command.started', data: { command: 'npx vitest run' } }),
    event({
      taskId: 'api',
      type: 'command.finished',
      data: { command: 'npx vitest run', exitCode: 0, durationMs: 1200, outputTail: 'ok' },
    }),
    event({ taskId: 'api', type: 'file.changed', data: { path: 'api.ts', action: 'created' } }),
    event({ taskId: 'api', type: 'file.changed', data: { path: 'api.ts', action: 'modified' } }),
  ];

  it('testes vêm do resultado registrado e, das tarefas em andamento, do fluxo ao vivo', () => {
    const runs = testRuns([done, running], events);
    expect(runs.map((run) => [run.command, run.exitCode, run.source])).toEqual([
      ['npm test', 1, 'result'],
      ['npx vitest run', 0, 'live'],
    ]);
  });

  it('arquivos: os do commit da tarefa e os escritos na worktree de quem ainda trabalha', () => {
    expect(changedFiles([done, running], events)).toEqual([
      { path: 'db.ts', status: 'A', taskId: 'db', source: 'result' },
      { path: 'api.ts', status: 'created', taskId: 'api', source: 'live' },
    ]);
  });

  it('o terminal junta o início e o fim de cada comando', () => {
    const entries = terminalEntries(events);
    expect(entries.find((entry) => entry.id === 's')).toMatchObject({
      command: 'npx vitest run',
      finished: true,
      exitCode: 0,
      output: 'ok',
    });
  });

  it('o tempo de execução conta da primeira tarefa iniciada', () => {
    const now = Date.parse('2026-10-29T10:05:00.000Z');
    expect(runElapsedMs(snapshot([task('a')]), now)).toBeNull();
    expect(
      runElapsedMs(
        snapshot([task('a', { status: 'running', startedAt: '2026-10-29T10:01:00.000Z' })]),
        now,
      ),
    ).toBe(4 * 60_000);
  });
});
