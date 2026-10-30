import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { HiveDatabase } from '@hive/persistence';
import {
  emptyCanvasLayout,
  type CanvasLayout,
  type CanvasQueenAction,
  type CanvasQueenApplied,
  type CanvasQueenProposal,
  type CanvasQueenRequest,
  type HivePush,
} from '@hive/core';
import type { ChatClient } from '@hive/providers';

vi.mock('electron', () => ({
  app: { getVersion: () => 'test' },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(text),
    decryptString: (buffer: Buffer) => buffer.toString(),
  },
}));
import { DesktopService } from './service';
import { CanvasQueen } from './canvas-queen';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

function setup(actions: CanvasQueenAction[] = []) {
  const db = new HiveDatabase(':memory:');
  const pushes: HivePush[] = [];
  const service = new DesktopService(db, os.tmpdir(), (push) => pushes.push(push));
  cleanups.push(() => {
    service.dispose();
    db.close();
  });
  const repos = service.repos;
  const at = new Date().toISOString();
  repos.workspaces.put({
    id: 'ws',
    name: 'Teste',
    path: os.tmpdir(),
    defaultBranch: 'main',
    createdAt: at,
    lastOpenedAt: at,
  });
  repos.providers.put({
    id: 'p',
    kind: 'openai-compatible',
    name: 'Configurado',
    baseUrl: 'http://127.0.0.1:1/v1',
    enabled: true,
    hasCredential: false,
    credentialHint: null,
    lastTest: null,
    modelsFetchedAt: null,
    createdAt: at,
  });
  const queen = repos.workers.list().find((worker) => worker.role === 'queen')!;
  const backend = repos.workers.list().find((worker) => worker.role === 'backend')!;
  for (const worker of [queen, backend])
    repos.workers.put({ ...worker, providerId: 'p', modelId: 'existing-model' });
  repos.missions.put({
    id: 'm',
    workspaceId: 'ws',
    title: 'Checkout',
    objective: 'Pagamento',
    createdAt: at,
  });
  repos.runs.put({
    id: 'r',
    missionId: 'm',
    workspaceId: 'ws',
    status: 'awaiting_plan_approval',
    baseBranch: 'main',
    baseCommit: 'abc',
    queenWorkerId: queen.id,
    planNotes: null,
    report: null,
    error: null,
    createdAt: at,
    finishedAt: null,
  });
  repos.saveMissionNote('m', '# Texto manual privado', 0);
  const chat = vi.fn<ChatClient['chat']>(async () => ({
    message: {
      role: 'assistant',
      content: JSON.stringify({ answer: 'Proposta para revisão.', actions }),
    },
    reasoning: null,
    finishReason: 'stop',
    usage: { promptTokens: 20, completionTokens: 10 },
    latencyMs: 1,
  }));
  const chatFor = vi.fn(() => ({ chat }));
  const engine = new CanvasQueen({
    repos,
    layout: (runId) =>
      JSON.parse(
        repos.getValue(`canvasLayout:${runId}`) ?? JSON.stringify(emptyCanvasLayout),
      ) as CanvasLayout,
    chatFor,
    invoke: (channel, input) => service.invoke(channel, input),
    planning: () => false,
    resultContext: (runId) => service.liveResults.context(runId),
    onEvent: (event) => pushes.push({ kind: 'event', event }),
  });
  Object.defineProperty(service, 'canvasQueen', { value: engine });
  const request: CanvasQueenRequest = {
    runId: 'r',
    instruction: 'Crie elementos para esta missão.',
    mode: 'ask',
    selectedNodeIds: [],
    view: 'workspace',
    center: { x: 123, y: 456 },
  };
  const propose = () =>
    service.invoke('canvas.queen.propose', request) as Promise<CanvasQueenProposal>;
  const approve = (proposal: CanvasQueenProposal) =>
    service.invoke('canvas.queen.apply', {
      runId: 'r',
      proposalId: proposal.id,
    }) as Promise<CanvasQueenApplied>;
  return { service, repos, request, propose, approve, backend, chat, chatFor, pushes };
}

it('propõe usando o modelo existente, aguarda aprovação e executa serviços reais uma única vez', async () => {
  const actions: CanvasQueenAction[] = [
    { type: 'create_note', text: 'Revisar API' },
    { type: 'create_group', title: 'Revisão' },
    { type: 'create_agent', name: 'Revisor adicional', role: 'reviewer' },
    { type: 'open_result' },
  ];
  const { repos, service, propose, approve, chat, chatFor } = setup(actions);
  const before = repos.workers.list().length;
  const proposal = await propose();
  expect(repos.workers.list()).toHaveLength(before);
  expect(await service.invoke('canvas.layout.get', 'r')).toEqual(emptyCanvasLayout);
  expect(chatFor).toHaveBeenCalledWith('p');
  expect(chat.mock.calls[0]?.[0].model).toBe('existing-model');
  expect(JSON.stringify(chat.mock.calls[0]?.[0].messages)).not.toContain('Texto manual privado');
  const result = await approve(proposal);
  expect(result.error).toBeNull();
  expect(result.applied).toHaveLength(3);
  const layout = (await service.invoke('canvas.layout.get', 'r')) as CanvasLayout;
  expect(layout.notes[0]).toMatchObject({ text: 'Revisar API', x: 123, y: 456 });
  expect(layout.frames[0]?.title).toBe('Revisão');
  expect(repos.workers.list()).toHaveLength(before + 1);
  expect(result.effects).toContainEqual({ type: 'open_result' });
  expect(repos.getMissionNote('m').text).toBe('# Texto manual privado');
  expect(repos.runs.get('r')?.status).toBe('awaiting_plan_approval');
  await expect(approve(proposal)).rejects.toThrow(/já aplicada/);
  expect(repos.usageSince(new Date(Date.now() - 60_000).toISOString()).promptTokens).toBe(20);
});

it('cria tarefas com as validações do scheduler, critérios e dependências reais', async () => {
  const { repos, propose, approve } = setup([
    {
      type: 'create_task',
      task: {
        key: 'api',
        title: 'Criar API',
        description: 'Endpoints de pagamento',
        workerId: null,
        dependsOn: [],
        acceptanceCriteria: ['Testes de integração passam'],
      },
    },
  ]);
  const proposal = await propose();
  expect(repos.tasks.list()).toHaveLength(0);
  await approve(proposal);
  expect(repos.tasks.list()).toMatchObject([{ runId: 'r', key: 'api', status: 'pending' }]);
});

it('recusa operações arbitrárias e campos que tentem modificar notas manuais', async () => {
  const { chat, propose, repos } = setup();
  for (const action of [
    { type: 'run_shell', command: 'whoami' },
    { type: 'create_note', text: 'x', overwriteUserNotes: true },
    { type: 'focus_node', nodeId: 'task:outra-missao' },
  ]) {
    chat.mockResolvedValueOnce({
      message: { role: 'assistant', content: JSON.stringify({ answer: 'x', actions: [action] }) },
      reasoning: null,
      finishReason: 'stop',
      usage: null,
      latencyMs: 1,
    });
    await expect(propose()).rejects.toThrow();
  }
  expect(repos.getMissionNote('m').text).toContain('Texto manual privado');
  expect(repos.tasks.list()).toHaveLength(0);
});

it('revalida o Canvas antes da aprovação e preserva mudanças manuais posteriores à prévia', async () => {
  const { service, propose, approve } = setup([{ type: 'create_note', text: 'IA' }]);
  const proposal = await propose();
  const manual: CanvasLayout = {
    ...emptyCanvasLayout,
    notes: [{ id: 'note:manual', text: 'Manual', x: 9, y: 7, tone: 'gold' }],
  };
  await service.invoke('canvas.layout.save', { runId: 'r', layout: manual });
  await expect(approve(proposal)).rejects.toThrow(/mudou desde a prévia/);
  expect(await service.invoke('canvas.layout.get', 'r')).toEqual(manual);
});

it('cancela propostas sem efeito e não aceita aprovação de outra missão', async () => {
  const { service, propose, approve } = setup([{ type: 'create_note', text: 'IA' }]);
  const proposal = await propose();
  await expect(
    service.invoke('canvas.queen.apply', { runId: 'outra', proposalId: proposal.id }),
  ).rejects.toThrow();
  await service.invoke('canvas.queen.cancel', { runId: 'r', proposalId: proposal.id });
  await expect(approve(proposal)).rejects.toThrow();
  expect(await service.invoke('canvas.layout.get', 'r')).toEqual(emptyCanvasLayout);
});

it('não interrompe a missão quando o modelo fica offline e bloqueia excesso de tokens', async () => {
  const { chat, repos, propose } = setup();
  chat.mockRejectedValueOnce(new Error('Modelo offline'));
  await expect(propose()).rejects.toThrow('Modelo offline');
  expect(repos.runs.get('r')?.status).toBe('awaiting_plan_approval');
  await propose();
  repos.saveSettings({ ...repos.getSettings(), dailyTokenBudget: 1 });
  await expect(propose()).rejects.toThrow(/Orçamento diário/);
  expect(chat).toHaveBeenCalledTimes(2);
});

it('expira prévias e impede alterações em comandos somente informativos', async () => {
  vi.useFakeTimers();
  const { service, request, propose, approve } = setup([{ type: 'create_note', text: 'IA' }]);
  await expect(
    service.invoke('canvas.queen.propose', { ...request, mode: 'progress' }),
  ).rejects.toThrow(/somente explicação/);
  const proposal = await propose();
  vi.setSystemTime(Date.now() + 600_001);
  await expect(approve(proposal)).rejects.toThrow(/expirou/);
});

it('cancela uma consulta em andamento e impede consultas concorrentes para a mesma missão', async () => {
  const { service, propose, chat, repos } = setup();
  chat.mockImplementationOnce(
    (_request, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('Cancelado')), { once: true });
      }),
  );
  const pending = expect(propose()).rejects.toThrow('Cancelado');
  await vi.waitFor(() => expect(chat).toHaveBeenCalledOnce());
  await expect(propose()).rejects.toThrow(/já está analisando/);
  await service.invoke('canvas.queen.cancel', { runId: 'r' });
  await pending;
  expect(repos.runs.get('r')?.status).toBe('awaiting_plan_approval');
});

it('reporta operações reais já concluídas se uma gravação posterior falha, sem repetir agentes', async () => {
  const { service, repos, propose, approve } = setup([
    { type: 'create_agent', name: 'Revisor', role: 'reviewer' },
    { type: 'create_note', text: 'Não deve chegar aqui' },
  ]);
  const proposal = await propose();
  const invoke = service.invoke.bind(service);
  vi.spyOn(service, 'invoke').mockImplementation((channel, input) =>
    channel === 'canvas.layout.save'
      ? Promise.reject(new Error('Disco indisponível'))
      : invoke(channel, input),
  );
  const count = repos.workers.list().length;
  const receipt = await approve(proposal);
  expect(receipt.error).toContain('após 1 ação');
  expect(receipt.applied[0]).toContain('Revisor');
  expect(repos.workers.list()).toHaveLength(count + 1);
  await expect(approve(proposal)).rejects.toThrow(/já aplicada/);
  expect(repos.workers.list()).toHaveLength(count + 1);
});

it('limita a consulta a sessenta segundos sem parar a execução da missão', async () => {
  vi.useFakeTimers();
  const { propose, chat, repos } = setup();
  chat.mockImplementationOnce(
    (_request, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('Tempo da consulta esgotado')), {
          once: true,
        });
      }),
  );
  const pending = expect(propose()).rejects.toThrow('Tempo da consulta esgotado');
  await vi.advanceTimersByTimeAsync(60_000);
  await pending;
  expect(repos.runs.get('r')?.status).toBe('awaiting_plan_approval');
});
