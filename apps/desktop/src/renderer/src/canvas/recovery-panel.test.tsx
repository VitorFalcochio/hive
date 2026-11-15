// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CanvasSnapshot, HiveBridge, NexusAutopilotRecovery } from '@hive/core';
import { RecoveryPanel } from './recovery-panel';

const at = '2026-11-15T10:00:00.000Z';

const recovery = (patch: Partial<NexusAutopilotRecovery> = {}): NexusAutopilotRecovery => ({
  id: 'recovery-1',
  runId: 'run',
  missionId: 'mission',
  taskId: 'task_api',
  taskKey: 'api',
  taskTitle: 'Criar API',
  rootTaskKey: 'api',
  attempt: 1,
  error: 'Cannot find module ./session',
  signature: 'cannot find module <path>',
  dependents: ['review'],
  state: 'proposed',
  draft: {
    strategy: 'split',
    diagnosis: 'O módulo de sessão ainda não existe.',
    rationale: 'Criar a sessão antes da API.',
    agents: [{ source: 'existing', key: 'backend', workerId: 'backend' }],
    tasks: [
      {
        key: 'sessao',
        title: 'Criar módulo de sessão',
        description: 'd',
        workerKey: 'backend',
        dependsOn: [],
        acceptanceCriteria: ['ok'],
      },
    ],
    resumeFrom: ['sessao'],
    warnings: ['Revise a expiração da sessão.'],
  },
  reason: null,
  queen: { name: 'Queen', modelId: 'model' },
  usage: { promptTokens: 80, completionTokens: 40 },
  applied: null,
  createdAt: at,
  updatedAt: at,
  ...patch,
});

const snapshot = (recoveries: NexusAutopilotRecovery[]): CanvasSnapshot => ({
  detail: {
    run: {
      id: 'run',
      missionId: 'mission',
      workspaceId: 'workspace',
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
  recoveries,
  at,
});

let invoke: ReturnType<typeof vi.fn>;
afterEach(cleanup);
beforeEach(() => {
  invoke = vi.fn(async () => recovery({ state: 'applied' }));
  Object.defineProperty(window, 'hive', {
    configurable: true,
    value: { invoke, subscribe: vi.fn(() => () => undefined) } as unknown as HiveBridge,
  });
});

it('não aparece quando nenhum ramo espera decisão', () => {
  const { container } = render(<RecoveryPanel snapshot={snapshot([])} />);
  expect(container.innerHTML).toBe('');
});

it('mostra o diagnóstico, as tarefas novas e só aplica no clique de aprovação', async () => {
  render(<RecoveryPanel snapshot={snapshot([recovery()])} />);
  expect(screen.getByText('Aguardando aprovação')).toBeTruthy();
  expect(screen.getByText('O módulo de sessão ainda não existe.')).toBeTruthy();
  expect(screen.getByText('Criar módulo de sessão')).toBeTruthy();
  expect(screen.getByText('review passam a esperar sessao.')).toBeTruthy();
  expect(screen.getByText('Revise a expiração da sessão.')).toBeTruthy();
  expect(invoke).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: /Aprovar e continuar/ }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('canvas.autopilot.recovery.apply', {
      runId: 'run',
      recoveryId: 'recovery-1',
    }),
  );
});

it('encerrar o ramo pede confirmação e avisa quais tarefas serão canceladas', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<RecoveryPanel snapshot={snapshot([recovery()])} />);
  fireEvent.click(screen.getByRole('button', { name: /Encerrar ramo/ }));
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('(review) serão canceladas'));
  expect(invoke).not.toHaveBeenCalled();

  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: /Encerrar ramo/ }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('canvas.autopilot.recovery.dismiss', {
      runId: 'run',
      recoveryId: 'recovery-1',
    }),
  );
  confirm.mockRestore();
});

it('no limite, não oferece nova sugestão: só repetir a tarefa ou encerrar', async () => {
  render(
    <RecoveryPanel
      snapshot={snapshot([
        recovery({ state: 'exhausted', draft: null, reason: 'O mesmo erro voltou.' }),
      ])}
    />,
  );
  expect(screen.getByText('Precisa de você')).toBeTruthy();
  expect(screen.getByText('O mesmo erro voltou.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Aprovar/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /sugest/i })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Repetir tarefa/ }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('task.retry', 'task_api'));
});
