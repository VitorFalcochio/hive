// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';

const emptySummary = {
  workspace: null,
  recentMissions: [],
  activeTasks: [],
  recentRuns: [],
  pendingApprovals: [],
  usage: { promptTokens: 0, completionTokens: 0, runsCounted: 0 },
  providers: [],
  workers: 0,
};
const provider = {
  id: 'p1',
  kind: 'nvidia',
  name: 'NVIDIA',
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  enabled: true,
  hasCredential: true,
  credentialHint: 'nvap…1234',
  lastTest: null,
  modelsFetchedAt: null,
  createdAt: '2026-01-01',
};
const queen = {
  id: 'w1',
  name: 'Queen · Coordinator',
  role: 'queen',
  description: 'Coordena.',
  providerId: null as string | null,
  modelId: null as string | null,
  skills: [],
  tools: [],
  autoApproveCommands: [],
  systemPrompt: '',
  limits: {},
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};

function mount(handlers: Record<string, (input: unknown) => unknown>) {
  const invoke = vi.fn(async (channel: string, input?: unknown) => {
    if (channel in handlers) return handlers[channel]!(input);
    if (channel === 'dashboard.summary') return emptySummary;
    if (channel === 'app.info')
      return { version: '0.1.0', dataDir: 'test-data', secretStorage: { available: true } };
    return [];
  });
  window.hive = { invoke, subscribe: () => () => undefined } as unknown as Window['hive'];
  render(<App />);
  return invoke;
}

afterEach(cleanup);

it('abre sem credenciais, explica a preparação e abre o cadastro de provedor em um modal', async () => {
  mount({});
  await waitFor(() => expect(screen.queryByText('Carregando o Hive…')).toBeNull());
  const header = screen.getByRole('heading', { name: 'Vamos construir.' }).closest('.page-header');
  expect(
    within(header as HTMLElement)
      .getByRole('button', { name: /Nova missão/ })
      .hasAttribute('disabled'),
  ).toBe(true);
  expect(screen.getByText(/até você revisar/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Provedores' }));
  expect(screen.getByRole('heading', { name: 'Provedores de IA' })).toBeTruthy();
  expect(screen.queryByLabelText('URL da API')).toBeNull();
  fireEvent.click(screen.getAllByRole('button', { name: /Adicionar provedor/ })[0]!);
  const dialog = screen.getByRole('dialog', { name: 'Adicionar provedor' });
  expect(within(dialog).getByLabelText(/Chave de API/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('combobox', { name: /Tipo/ }));
  expect(screen.getByRole('option', { name: /Groq.*Grátis/ })).toBeTruthy();
  fireEvent.click(screen.getByRole('option', { name: /Google Gemini/ }));
  expect(within(dialog).getByText(/modelos Flash/)).toBeTruthy();
  expect(within(dialog).getByLabelText('URL da API')).toBeTruthy();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('ao escolher o provedor de um agente, escolhe e testa o modelo automaticamente', async () => {
  let worker = { ...queen };
  const invoke = mount({
    'provider.list': () => [provider],
    'worker.list': () => [worker],
    'worker.autoConfigure': () => {
      worker = { ...worker, providerId: 'p1', modelId: 'z-ai/glm-5.3', updatedAt: '2026-01-02' };
      return {
        assignments: [{ workerId: 'w1', workerName: worker.name, modelId: 'z-ai/glm-5.3' }],
        unavailable: [],
      };
    },
  });
  await waitFor(() => expect(screen.queryByText('Carregando o Hive…')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Agentes' }));
  fireEvent.click(screen.getByRole('combobox', { name: /Provedor/ }));
  fireEvent.click(screen.getByRole('option', { name: 'NVIDIA' }));
  await waitFor(() => expect(screen.getByText('testado')).toBeTruthy());
  expect(invoke).toHaveBeenCalledWith('worker.autoConfigure', { workerId: 'w1', providerId: 'p1' });
  expect(screen.getAllByText('z-ai/glm-5.3').length).toBeGreaterThan(0);
});
