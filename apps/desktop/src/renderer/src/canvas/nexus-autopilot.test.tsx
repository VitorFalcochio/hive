// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  CanvasSnapshot,
  HiveBridge,
  NexusAutopilotPlan,
  NexusAutopilotDraft,
} from '@hive/core';
import { NexusAutopilot } from './nexus-autopilot';

const at = '2026-10-29T10:00:00.000Z';
const snapshot: CanvasSnapshot = {
  detail: {
    run: {
      id: 'run',
      missionId: 'mission',
      workspaceId: 'workspace',
      status: 'awaiting_plan_approval',
      baseBranch: 'main',
      baseCommit: 'abc',
      queenWorkerId: 'queen',
      planNotes: null,
      report: null,
      error: null,
      createdAt: at,
      finishedAt: null,
    },
    mission: {
      id: 'mission',
      workspaceId: 'workspace',
      title: 'Autenticação',
      objective: 'Login seguro',
      createdAt: at,
    },
    tasks: [],
    approvals: [],
  },
  workspace: { id: 'workspace', name: 'Projeto' },
  workers: [
    {
      id: 'queen',
      name: 'Queen',
      role: 'queen',
      beeColor: null,
      providerId: 'provider',
      providerName: 'Provider',
      modelId: 'model',
    },
    {
      id: 'backend',
      name: 'Backend',
      role: 'backend',
      beeColor: null,
      providerId: 'provider',
      providerName: 'Provider',
      modelId: 'model',
    },
  ],
  terminals: [],
  usage: {},
  planning: false,
  queuePosition: null,
  at,
};
const draft: NexusAutopilotDraft = {
  objective: 'Construir autenticação completa.',
  agents: [{ source: 'existing', key: 'backend', workerId: 'backend' }],
  tasks: [
    {
      key: 'api',
      title: 'Criar API',
      description: 'Implementar endpoints.',
      workerKey: 'backend',
      dependsOn: [],
      acceptanceCriteria: ['Testes passam.'],
    },
  ],
  connectResult: true,
  approvalSteps: ['Aprovar comandos quando solicitado.'],
  warnings: [],
};
const plan = (version = 1, patch: Partial<NexusAutopilotPlan> = {}): NexusAutopilotPlan => ({
  id: `plan-${version}`,
  runId: 'run',
  missionId: 'mission',
  version,
  origin: version === 1 ? 'autopilot' : 'manual',
  state: 'proposed',
  instruction: 'Crie autenticação.',
  useExistingAgents: true,
  allowNewAgents: true,
  draft,
  basedOnPlanId: version === 1 ? null : 'plan-1',
  changeSummary: 'Plano de teste.',
  createdAt: at,
  updatedAt: at,
  queen: { name: 'Queen', modelId: 'model' },
  usage: { promptTokens: 10, completionTokens: 5 },
  fingerprint: 'state',
  applied: null,
  error: null,
  ...patch,
});

afterEach(cleanup);
beforeEach(() => {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'canvas.autopilot.current') return [];
    if (channel === 'canvas.autopilot.propose') return plan();
    if (channel === 'canvas.autopilot.revise')
      return plan(2, { draft: { ...draft, tasks: [{ ...draft.tasks[0]!, title: 'API segura' }] } });
    if (channel === 'canvas.autopilot.apply')
      return {
        plan: plan(2, {
          state: 'applied',
          applied: {
            agentIds: { backend: 'backend' },
            taskIds: { api: 'task' },
            started: false,
            at,
          },
        }),
        createdAgents: 0,
        createdTasks: 1,
        started: false,
        alreadyApplied: false,
      };
    return undefined;
  });
  Object.defineProperty(window, 'hive', {
    configurable: true,
    value: { invoke, subscribe: vi.fn(() => () => undefined) } as unknown as HiveBridge,
  });
});

it('gera prévia navegável, permite editar uma tarefa e só aplica após o clique explícito', async () => {
  const onApplied = vi.fn(async () => undefined);
  render(
    <NexusAutopilot
      snapshot={snapshot}
      beforeRequest={vi.fn(async () => undefined)}
      onApplied={onApplied}
      onClose={vi.fn()}
    />,
  );
  await waitFor(() => expect(screen.getByLabelText('Objetivo para a Queen')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Objetivo para a Queen'), {
    target: { value: 'Crie autenticação.' },
  });
  fireEvent.click(screen.getByRole('button', { name: /Gerar fluxo/ }));
  await waitFor(() => expect(screen.getByLabelText('Prévia visual do fluxo')).toBeTruthy());
  expect(screen.getByText('Criar API')).toBeTruthy();
  expect(onApplied).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Editar plano' }));
  fireEvent.change(screen.getByLabelText('Título da tarefa'), {
    target: { value: 'API segura' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar nova versão' }));
  await waitFor(() => expect(screen.getByText('API segura')).toBeTruthy());
  expect(screen.getByText('Versão 2')).toBeTruthy();
  expect(onApplied).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Aplicar fluxo' }));
  await waitFor(() => expect(onApplied).toHaveBeenCalledOnce());
  expect(screen.getByText('Fluxo aplicado')).toBeTruthy();
});
