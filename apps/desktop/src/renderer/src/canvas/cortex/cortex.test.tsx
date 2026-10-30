// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultCortexConfig,
  type CanvasSnapshot,
  type CanvasWorker,
  type CortexOverview,
  type CortexProposal,
  type HiveBridge,
} from '@hive/core';
import { buildGraph, nodeId } from '../model';
import { CommandRegistry, registerCanvasCommands, type CommandContext } from '../command-registry';
import { CortexInspector } from './CortexInspector';
import { BLOCK_MIME, BlockLibrary } from './BlockLibrary';

const at = '2026-10-30T10:00:00.000Z';
const worker = (id: string, role: CanvasWorker['role']): CanvasWorker => ({
  id,
  name: id === 'back' ? 'Backend' : id === 'front' ? 'Frontend' : id,
  role,
  beeColor: null,
  providerId: 'p1',
  providerName: 'Provedor',
  modelId: 'modelo',
});
const workers = [
  worker('queen', 'queen'),
  worker('back', 'backend'),
  worker('front', 'frontend'),
  worker('qa', 'qa'),
];

const snapshot: CanvasSnapshot = {
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
    tasks: [
      {
        id: 't1',
        runId: 'r1',
        key: 'api',
        title: 'API',
        description: '',
        workerId: 'back',
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
      },
    ],
    approvals: [],
  },
  workspace: { id: 'ws1', name: 'loja' },
  workers,
  usage: {},
  planning: false,
  queuePosition: null,
  terminals: [],
  at,
};

const block = (patch: Partial<CortexOverview> = {}): CortexOverview => ({
  node: {
    id: 'cx1',
    workspaceId: 'ws1',
    name: 'Cortex',
    description: 'Shared Intelligent Memory',
    config: defaultCortexConfig,
    connections: [
      {
        workerId: 'back',
        permissions: { read: true, propose: true, approve: false, manage: false },
        connectedAt: at,
        source: 'user',
      },
    ],
    createdAt: at,
    updatedAt: at,
  },
  memories: { active: 0, superseded: 0, revoked: 0 },
  decisions: 0,
  pendingApprovals: 1,
  pendingNotifications: 0,
  lastActivityAt: at,
  embedding: { model: 'hive-local-concepts-v1', degraded: null },
  ...patch,
});

const proposal: CortexProposal = {
  id: 'cxp1',
  cortexId: 'cx1',
  workspaceId: 'ws1',
  action: 'create',
  targetMemoryId: null,
  draft: {
    kind: 'decision',
    title: 'Autenticação com JWT',
    content: 'Bearer token assinado.',
    rationale: 'Sem sessão no servidor.',
    tags: [],
    evidence: ['src/auth.ts'],
    audience: ['frontend'],
  },
  proposer: { kind: 'agent', workerId: 'back', name: 'Backend' },
  origin: { runId: 'r1', missionId: 'm1', taskId: 't1' },
  status: 'pending',
  duplicates: [],
  reviews: [],
  resolution: null,
  createdAt: at,
  updatedAt: at,
};

function bridge(handler: (channel: string, input: unknown) => unknown) {
  const invoke = vi.fn(async (channel: string, input?: unknown) => handler(channel, input));
  window.hive = { invoke, subscribe: () => () => undefined } as unknown as HiveBridge;
  return invoke;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Cortex no Nexus', () => {
  it('desenha o bloco e só liga ao Cortex os agentes conectados', () => {
    const graph = buildGraph(snapshot, {
      grouping: 'workspace',
      collapsed: new Set(),
      extraAgents: ['back'],
      cortex: [{ id: 'cx1', workers: ['back', 'qa'] }],
    });
    expect(graph.nodes.find((node) => node.id === nodeId.cortex('cx1'))?.type).toBe('cortex');
    const memory = graph.edges.filter((edge) => edge.kind === 'memory');
    // The QA agent is not on the canvas, so no line is drawn to it; the backend's is.
    expect(memory.map((edge) => edge.source)).toEqual([nodeId.agent('back')]);
    expect(memory[0]?.target).toBe(nodeId.cortex('cx1'));
  });

  it('o menu de blocos tem a categoria Cortex e o bloco é arrastável', () => {
    const place = vi.fn();
    render(<BlockLibrary onPlace={place} onClose={() => {}} />);
    expect(screen.getByText('Cortex', { selector: 'h4' })).toBeTruthy();
    const item = screen.getByRole('button', { name: /Cortex — Shared Memory/ });
    expect(item.getAttribute('draggable')).toBe('true');
    const data = new Map<string, string>();
    fireEvent.dragStart(item, {
      dataTransfer: { setData: (type: string, value: string) => data.set(type, value) },
    });
    expect(data.get(BLOCK_MIME)).toBe('cortex');
    fireEvent.click(item);
    expect(place).toHaveBeenCalledWith('cortex');
  });

  it('a paleta de comandos oferece o Cortex na própria categoria', () => {
    const registry = registerCanvasCommands(new CommandRegistry<CommandContext>());
    const hits = registry.search('cortex shared memory', {
      snapshot,
      ready: true,
      selectedNodeIds: [],
      perform: () => {},
      reveal: () => {},
      find: () => {},
      ask: () => {},
      autopilot: () => {},
    });
    const hit = hits.find((item) => item.command.id === 'cortex.new');
    expect(hit?.command.category).toBe('Cortex');
    expect(hit?.available).toBe(true);
  });

  it('o Inspector mostra a proposta pendente com origem e justificativa, e aprova pelo motor', async () => {
    const invoke = bridge((channel) => {
      if (channel === 'cortex.proposals') return [proposal];
      if (channel === 'cortex.memories') return [];
      return undefined;
    });
    render(
      <CortexInspector
        block={block()}
        workers={new Map(workers.map((item) => [item.id, item]))}
        initialTab="approvals"
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText('Autenticação com JWT')).toBeTruthy();
    expect(screen.getByText(/Justificativa: Sem sessão no servidor/)).toBeTruthy();
    expect(screen.getByText(/Evidências: src\/auth.ts/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Aprovar/ }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('cortex.proposal.resolve', {
        proposalId: 'cxp1',
        decision: 'approve',
        note: '',
      }),
    );
    expect(await screen.findByText(/agora é memória compartilhada/)).toBeTruthy();
  });

  it('mostra estados vazio e de erro com nova tentativa', async () => {
    let fail = true;
    bridge((channel) => {
      if (channel === 'cortex.memories') {
        if (fail) throw new Error('Banco indisponível');
        return [];
      }
      return undefined;
    });
    render(
      <CortexInspector
        block={block()}
        workers={new Map()}
        initialTab="memories"
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText('Banco indisponível')).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: /Tentar de novo/ }));
    expect(await screen.findByText(/Nenhuma memória ainda/)).toBeTruthy();
  });

  it('as conexões mostram as permissões de cada agente e alteram pelo motor', async () => {
    const invoke = bridge((channel) => (channel === 'provider.list' ? [] : undefined));
    render(
      <CortexInspector
        block={block()}
        workers={new Map(workers.map((item) => [item.id, item]))}
        initialTab="connections"
        onClose={() => {}}
      />,
    );
    const approve = screen.getByRole('checkbox', {
      name: 'approve para Backend',
    }) as HTMLInputElement;
    expect(approve.checked).toBe(false);
    fireEvent.click(approve);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('cortex.permissions', {
        cortexId: 'cx1',
        workerId: 'back',
        permissions: { read: true, propose: true, approve: true, manage: false },
      }),
    );
  });
});
