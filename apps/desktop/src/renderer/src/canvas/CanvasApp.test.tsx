// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  emptyCanvasLayout,
  type AgentEvent,
  type CanvasRunSummary,
  type CanvasSnapshot,
  type HivePush,
  type Task,
  type LiveResult,
  type CanvasLayout,
} from '@hive/core';
import { CanvasApp } from './CanvasApp';

// xterm.js draws on a canvas jsdom does not have; the session id is enough here.
vi.mock('../terminal-view', () => ({
  TerminalView: ({ session }: { session: { id: string } }) => <pre>terminal {session.id}</pre>,
}));

beforeAll(() => {
  // xyflow measures the page; jsdom has no layout, so these are inert stand-ins.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  globalThis.DOMMatrixReadOnly ??= class {
    m22 = 1;
    constructor() {}
  } as unknown as typeof DOMMatrixReadOnly;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});
beforeEach(() => {
  // The console starts closed; these tests read the live log in it.
  localStorage.setItem('hive.canvas.prefs', JSON.stringify({ consoleOpen: true }));
});

const at = '2026-10-29T10:00:00.000Z';
const task = (patch: Partial<Task>): Task => ({
  id: 't1',
  runId: 'r1',
  key: 'api',
  title: 'Criar a API',
  description: 'Endpoints de pagamento',
  workerId: 'back',
  dependsOn: [],
  acceptanceCriteria: ['Testes passam'],
  status: 'running',
  workerState: 'coding',
  attempt: 1,
  branch: 'hive/r1/api-1',
  startCommit: 'abc',
  worktreePath: null,
  result: null,
  error: null,
  createdAt: at,
  startedAt: at,
  finishedAt: null,
  ...patch,
});
const runs: CanvasRunSummary[] = [
  {
    runId: 'r1',
    missionId: 'm1',
    missionTitle: 'Checkout',
    workspaceId: 'ws1',
    workspaceName: 'loja',
    status: 'running',
    createdAt: at,
    finishedAt: null,
    tasks: { total: 1, done: 0, running: 1, failed: 0 },
  },
];
const snapshot = (
  tasks: Task[],
  status: CanvasSnapshot['detail']['run']['status'] = 'running',
): CanvasSnapshot => ({
  detail: {
    run: {
      id: 'r1',
      missionId: 'm1',
      workspaceId: 'ws1',
      status,
      baseBranch: 'main',
      baseCommit: 'abc123',
      queenWorkerId: null,
      planNotes: null,
      report: null,
      error: null,
      createdAt: at,
      finishedAt: null,
    },
    mission: { id: 'm1', workspaceId: 'ws1', title: 'Checkout', objective: 'Pagar', createdAt: at },
    tasks,
    approvals: [],
  },
  workspace: { id: 'ws1', name: 'loja' },
  workers: [
    {
      id: 'back',
      name: 'Backend Developer',
      role: 'backend',
      beeColor: null,
      providerId: 'p1',
      providerName: 'OpenRouter',
      modelId: 'b-model',
    },
  ],
  usage: {},
  planning: false,
  queuePosition: null,
  terminals: [],
  at,
});

function mount(initial: Task[], layout: CanvasLayout = emptyCanvasLayout, withQueen = false) {
  let current = snapshot(initial);
  if (withQueen)
    current.workers.push({
      id: 'queen',
      name: 'Queen',
      role: 'queen',
      beeColor: null,
      providerId: 'p1',
      providerName: 'Local',
      modelId: 'q-model',
    });
  let report: LiveResult = {
    version: 1,
    runId: 'r1',
    missionId: 'm1',
    cursor: 0,
    eventCount: 0,
    changeCount: 0,
    updatedAt: at,
    mode: 'deterministic',
    summary: 'API em desenvolvimento. Testes não executados.',
    completed: [],
    active: ['api'],
    remaining: [],
    risks: [],
    next: [],
    files: [],
    tests: [],
    updates: [],
  };
  let note = { missionId: 'm1', text: '', revision: 0, updatedAt: null as string | null };
  const history: AgentEvent[] = [];
  const listeners = new Set<(push: HivePush) => void>();
  const invoke = vi.fn(async (channel: string, _input?: unknown): Promise<unknown> => {
    if (channel === 'app.info') return { platform: 'win32' };
    if (channel === 'canvas.runs') return runs;
    if (channel === 'canvas.snapshot') return current;
    if (channel === 'canvas.result.get') return report;
    if (channel === 'canvas.notes.get') return note;
    if (channel === 'canvas.notes.save') {
      const next = _input as { text: string; revision: number };
      note = { ...note, text: next.text, revision: next.revision + 1, updatedAt: at };
      return note;
    }
    if (channel === 'canvas.result.events') {
      const {
        after,
        before,
        limit = 100,
      } = _input as { after?: number; before?: number; limit?: number };
      const events = history
        .map((event, index) => ({ cursor: index + 1, event }))
        .filter(
          (item) =>
            (after === undefined || item.cursor > after) &&
            (before === undefined || item.cursor < before),
        );
      return {
        events: after === undefined ? events.slice(-limit) : events.slice(0, limit),
        hasMore: events.length > limit,
      };
    }
    if (channel === 'events.query') return [] as AgentEvent[];
    if (channel === 'canvas.layout.get') return layout;
    if (channel === 'canvas.layout.save') {
      layout = (_input as { layout: CanvasLayout }).layout;
      return;
    }
    if (channel === 'provider.list') return [];
    if (channel === 'canvas.terminal.open')
      return {
        workerId: 'back',
        kind: 'shell',
        taskId: null,
        session: {
          id: 'terminal_1',
          workspaceId: 'ws1',
          command: '',
          cwd: '/repo',
          status: 'running',
          output: '',
          startedAt: at,
          endedAt: null,
          exitCode: null,
          previewUrls: [],
        },
      };
    return undefined;
  });
  window.hive = {
    invoke,
    subscribe: (listener: (push: HivePush) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as Window['hive'];
  render(<CanvasApp />);
  const push = (value: HivePush) => act(() => listeners.forEach((listener) => listener(value)));
  return {
    invoke,
    push,
    listeners,
    result: (patch: Partial<LiveResult>) => {
      report = { ...report, ...patch };
      push({ kind: 'changed', entity: 'result', id: 'r1' });
    },
    history,
    update: (tasks: Task[], status?: CanvasSnapshot['detail']['run']['status']) => {
      current = snapshot(tasks, status);
    },
  };
}

it('mostra a missão real, recebe eventos ao vivo e acompanha a mudança de estado', async () => {
  const hive = mount([task({})]);
  const inspector = await screen.findByRole('complementary', { name: 'Inspector' });
  expect(within(inspector).getByRole('heading', { name: 'Checkout' })).toBeTruthy();
  expect(screen.getByTitle('Agentes trabalhando agora').textContent).toContain('1');
  expect(screen.getByTitle('Tarefas concluídas / total').textContent).toContain('0/1');

  hive.push({
    kind: 'event',
    event: {
      id: 'e1',
      ts: at,
      workspaceId: 'ws1',
      runId: 'r1',
      taskId: 't1',
      workerId: 'back',
      type: 'tool.call',
      level: 'info',
      message: 'Editando src/api.ts',
      data: null,
    },
  });
  const console = screen.getByRole('region', { name: 'Execution Console' });
  expect(await within(console).findByText('Editando src/api.ts')).toBeTruthy();
  // Events of other runs never reach this one.
  hive.push({
    kind: 'event',
    event: {
      id: 'e2',
      ts: at,
      workspaceId: 'ws1',
      runId: 'other',
      taskId: null,
      workerId: null,
      type: 'info',
      level: 'info',
      message: 'de outra missão',
      data: null,
    },
  });
  expect(screen.queryByText('de outra missão')).toBeNull();

  // The scheduler settles the run as failed once its only task fails.
  hive.update(
    [task({ status: 'failed', workerState: 'failed', error: 'Testes falharam' })],
    'failed',
  );
  hive.push({ kind: 'changed', entity: 'task', id: 't1' });
  await waitFor(() =>
    expect(screen.getByTitle('Agentes trabalhando agora').textContent).toContain('0'),
  );
  // Only the run's real actions: no cancel once nothing runs, resume once a task failed.
  expect(screen.getByRole('button', { name: /Retomar/ })).toBeTruthy();
});

it('abre Resultado Vivo, salva Markdown e preserva as notas ao atualizar o relatório', async () => {
  const hive = mount([task({})]);
  fireEvent.click(await screen.findByRole('button', { name: 'Expandir relatório e notas' }));
  const panel = screen.getByRole('dialog', { name: 'Resultado Vivo' });
  expect(within(panel).getByText(/Sumarização narrativa por IA ainda não habilitada/)).toBeTruthy();
  fireEvent.click(within(panel).getByRole('button', { name: 'Minhas Notas' }));
  const editor = await within(panel).findByRole('textbox', { name: 'Minhas Notas em Markdown' });
  await waitFor(() => expect((editor as HTMLTextAreaElement).disabled).toBe(false));
  fireEvent.change(editor, {
    target: { value: '# Minhas decisões\n- [ ] Revisar API\n```ts\nconst x = 1;\n```' },
  });
  hive.result({
    cursor: 1,
    changeCount: 1,
    summary: 'Backend concluiu a API. Testes não executados.',
  });
  await waitFor(
    () =>
      expect(hive.invoke).toHaveBeenCalledWith(
        'canvas.notes.save',
        expect.objectContaining({ text: expect.stringContaining('# Minhas decisões') }),
      ),
    { timeout: 2000 },
  );
  expect((editor as HTMLTextAreaElement).value).toContain('Revisar API');
  fireEvent.click(within(panel).getByRole('button', { name: 'Fechar Resultado Vivo' }));
  fireEvent.click(screen.getByRole('button', { name: 'Expandir relatório e notas' }));
  const reopened = screen.getByRole('dialog', { name: 'Resultado Vivo' });
  fireEvent.click(within(reopened).getByRole('button', { name: 'Minhas Notas' }));
  await waitFor(() =>
    expect((within(reopened).getByRole('textbox') as HTMLTextAreaElement).value).toContain(
      '# Minhas decisões',
    ),
  );
  expect(hive.invoke.mock.calls.some(([channel]) => channel === 'run.cancel')).toBe(false);
});

it('reconcilia rajadas de histórico por cursor sem lacunas e preserva posição e tamanho manuais', async () => {
  const hive = mount([task({})], {
    ...emptyCanvasLayout,
    pinned: { workspace: { 'result:m1': { x: 1200, y: 210 } } },
    sizes: { 'result:m1': { width: 390, height: 260 } },
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Expandir relatório e notas' }));
  await waitFor(() =>
    expect(hive.invoke).toHaveBeenCalledWith('canvas.result.events', expect.anything()),
  );
  for (let index = 0; index < 205; index++)
    hive.history.push({
      id: `burst-${index}`,
      ts: at,
      runId: 'r1',
      taskId: 't1',
      workerId: 'back',
      workspaceId: 'ws1',
      type: 'file.changed',
      level: 'info',
      message: `burst-${index}`,
      data: { path: `file-${index}.ts` },
    });
  hive.result({ cursor: 205, changeCount: 205 });
  const panel = screen.getByRole('dialog', { name: 'Resultado Vivo' });
  await waitFor(() => expect(panel.querySelectorAll('.nc-result-timeline li')).toHaveLength(205), {
    timeout: 3000,
  });
  expect(hive.invoke).toHaveBeenCalledWith(
    'canvas.result.events',
    expect.objectContaining({ after: 100 }),
  );
  const resultNode = document.querySelector('[data-id="result:m1"]') as HTMLElement;
  expect(resultNode.style.transform.replace(/\s/g, '')).toContain('1200px,210px');
  expect(resultNode.style.width).toBe('390px');
  expect(resultNode.style.height).toBe('260px');
});

it('libera os ouvintes ao fechar e não executa nada sozinho', async () => {
  const hive = mount([task({})]);
  await screen.findByRole('complementary', { name: 'Inspector' });
  expect(hive.listeners.size).toBeGreaterThan(0);
  const calls = hive.invoke.mock.calls.map(([channel]) => channel);
  expect(calls.every((channel) => !/^(run|task)\./.test(channel))).toBe(true);
  cleanup();
  expect(hive.listeners.size).toBe(0);
});

it('cancelar a execução pede confirmação e usa o mesmo motor do Hive', async () => {
  const hive = mount([task({})]);
  await screen.findByRole('complementary', { name: 'Inspector' });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: /Cancelar/ }));
  await waitFor(() => expect(hive.invoke).toHaveBeenCalledWith('run.cancel', 'r1'));
  expect(confirm).toHaveBeenCalledOnce();
});

it('no workspace, cada agente tem a própria janela com terminal real e o layout é salvo', async () => {
  const hive = mount([task({})]);
  await screen.findByRole('complementary', { name: 'Inspector' });
  // The agent's window, with what it does now, from the engine's own task.
  await waitFor(() => expect(document.querySelector('.nc-window')).toBeTruthy());
  const agentWindow = document.querySelector('.nc-window') as HTMLElement;
  expect(within(agentWindow).getByText('Backend Developer')).toBeTruthy();
  fireEvent.click(within(agentWindow).getByRole('tab', { name: /Terminal/ }));
  fireEvent.click(screen.getByRole('button', { name: /Abrir terminal/ }));
  await waitFor(() =>
    expect(hive.invoke).toHaveBeenCalledWith(
      'canvas.terminal.open',
      expect.objectContaining({ runId: 'r1', workerId: 'back', kind: 'shell' }),
    ),
  );
  expect(await screen.findByText('terminal terminal_1')).toBeTruthy();

  // A note is spatial only: it goes to the layout, never to the engine.
  fireEvent.keyDown(window, { key: 'n' });
  await waitFor(
    () =>
      expect(hive.invoke).toHaveBeenCalledWith(
        'canvas.layout.save',
        expect.objectContaining({
          runId: 'r1',
          layout: expect.objectContaining({ notes: [expect.objectContaining({ text: '' })] }),
        }),
      ),
    { timeout: 2000 },
  );
  const calls = hive.invoke.mock.calls.map(([channel]) => channel);
  expect(calls.some((channel) => channel.startsWith('canvas.task.'))).toBe(false);
});

const openPalette = async (query: string) => {
  fireEvent.keyDown(window, { key: ' ', code: 'Space', ctrlKey: true });
  const input = await screen.findByRole(
    'combobox',
    { name: 'Pesquisar comandos e elementos' },
    { timeout: 5_000 },
  );
  fireEvent.change(input, { target: { value: query } });
  return input;
};

it('a paleta cria nota persistente e encontra agente sem interferir na execução nem no Resultado Vivo', async () => {
  const hive = mount([task({})]);
  await screen.findByRole('complementary', { name: 'Inspector' });
  let input = await openPalette('Nova nota');
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(
    () =>
      expect(hive.invoke).toHaveBeenCalledWith(
        'canvas.layout.save',
        expect.objectContaining({
          runId: 'r1',
          layout: expect.objectContaining({
            notes: [expect.objectContaining({ id: expect.stringMatching(/^note:/) })],
          }),
        }),
      ),
    { timeout: 2000 },
  );
  input = await openPalette('Backend Developer');
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() =>
    expect(document.querySelector('[data-id="agent:back"]')?.classList.contains('selected')).toBe(
      true,
    ),
  );
  expect(screen.getByRole('button', { name: 'Expandir relatório e notas' })).toBeTruthy();
  expect(hive.invoke.mock.calls.some(([channel]) => /^(run|task)\./.test(channel))).toBe(false);
});

it('a paleta abre o formulário real de tarefa e oferece ações conforme o estado da missão', async () => {
  const hive = mount([task({})]);
  await screen.findByRole('complementary', { name: 'Inspector' });
  let input = await openPalette('Retomar missão');
  expect(screen.getByRole('option', { name: /Retomar missão/ }).getAttribute('aria-disabled')).toBe(
    'true',
  );
  fireEvent.keyDown(input, { key: 'Escape' });
  input = await openPalette('Nova tarefa');
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(await screen.findByRole('dialog', { name: 'Nova tarefa' })).toBeTruthy();
  expect(hive.invoke.mock.calls.some(([channel]) => channel === 'canvas.task.create')).toBe(false);
});

it('o modo Queen apresenta uma prévia, exige aprovação e reflete a nota criada nos serviços', async () => {
  const hive = mount([task({})], emptyCanvasLayout, true);
  const normal = hive.invoke.getMockImplementation()!;
  hive.invoke.mockImplementation(async (channel, input) => {
    if (channel === 'canvas.queen.propose')
      return {
        id: 'proposal',
        runId: 'r1',
        answer: 'Vou criar uma nota espacial para revisão.',
        actions: [{ type: 'create_note', text: 'Revisar API' }],
        queen: { name: 'Queen', modelId: 'q-model' },
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        usage: { promptTokens: 10, completionTokens: 10 },
      };
    if (channel === 'canvas.queen.apply') {
      await normal('canvas.layout.save', {
        runId: 'r1',
        layout: {
          ...emptyCanvasLayout,
          notes: [{ id: 'note:queen', text: 'Revisar API', x: 100, y: 100, tone: 'gold' }],
        },
      });
      return { applied: ['Criar nota espacial: Revisar API'], effects: [], error: null };
    }
    return normal(channel, input);
  });
  await screen.findByRole('complementary', { name: 'Inspector' });
  const input = await openPalette('Crie uma nota para revisão');
  fireEvent.keyDown(input, { key: 'Enter' });
  const preview = await screen.findByRole('region', { name: 'Prévia da Queen' });
  expect(within(preview).getByText('Vou criar uma nota espacial para revisão.')).toBeTruthy();
  expect(hive.invoke.mock.calls.some(([channel]) => channel === 'canvas.queen.apply')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Aprovar e executar 1 ação(ões)' }));
  await waitFor(() => expect(document.querySelector('[data-id="note:queen"]')).toBeTruthy());
  expect(hive.invoke).toHaveBeenCalledWith('canvas.queen.apply', {
    runId: 'r1',
    proposalId: 'proposal',
  });
  expect(hive.invoke.mock.calls.some(([channel]) => channel === 'run.cancel')).toBe(false);
});
