import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import {
  emptyCanvasLayout,
  type CanvasLayout,
  type HivePush,
  type NexusAutopilotDraft,
  type NexusAutopilotApplyResult,
  type NexusAutopilotPlan,
  type NexusAutopilotRequest,
} from '@hive/core';
import { HiveDatabase } from '@hive/persistence';
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
import { NexusAutopilot } from './nexus-autopilot';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(build?: (backendId: string) => unknown) {
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
    name: 'Projeto',
    path: os.tmpdir(),
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
  const queen = repos.workers.list().find((worker) => worker.role === 'queen')!;
  const backend = repos.workers.list().find((worker) => worker.role === 'backend')!;
  for (const worker of [queen, backend])
    repos.workers.put({ ...worker, providerId: 'provider', modelId: 'configured-model' });
  repos.missions.put({
    id: 'mission',
    workspaceId: 'ws',
    title: 'Autenticação',
    objective: 'Criar autenticação segura',
    createdAt: at,
  });
  repos.runs.put({
    id: 'run',
    missionId: 'mission',
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
  const defaultDraft: NexusAutopilotDraft = {
    objective: 'Implementar autenticação por camadas.',
    agents: [{ source: 'existing', key: 'backend', workerId: backend.id }],
    tasks: [
      {
        key: 'api',
        title: 'API de autenticação',
        description: 'Implementar endpoints e persistência.',
        workerKey: 'backend',
        dependsOn: [],
        acceptanceCriteria: ['Testes da API passam.'],
      },
      {
        key: 'review',
        title: 'Revisar autenticação',
        description: 'Validar segurança e regressões.',
        workerKey: 'backend',
        dependsOn: ['api'],
        acceptanceCriteria: ['Revisão não encontra falhas críticas.'],
      },
    ],
    connectResult: true,
    approvalSteps: ['Comandos destrutivos continuam sujeitos à aprovação do Hive.'],
    warnings: [],
  };
  const chat = vi.fn<ChatClient['chat']>(async () => ({
    message: {
      role: 'assistant',
      content: JSON.stringify(build?.(backend.id) ?? defaultDraft),
    },
    reasoning: null,
    finishReason: 'stop',
    usage: { promptTokens: 100, completionTokens: 50 },
    latencyMs: 1,
  }));
  let starts = 0;
  const engine = new NexusAutopilot({
    repos,
    layout: (runId) =>
      JSON.parse(
        repos.getValue(`canvasLayout:${runId}`) ?? JSON.stringify(emptyCanvasLayout),
      ) as CanvasLayout,
    chatFor: () => ({ chat }),
    invoke: async (channel, input) => {
      if (channel === 'run.start') {
        starts++;
        const run = repos.runs.require(String(input), 'Execução');
        repos.runs.put({ ...run, status: 'running' });
        return service.invoke('run.get', input);
      }
      return service.invoke(channel, input);
    },
    resultContext: (runId) => service.liveResults.context(runId),
    onEvent: (event) => pushes.push({ kind: 'event', event }),
  });
  Object.defineProperty(service, 'nexusAutopilot', { value: engine });
  const request: NexusAutopilotRequest = {
    runId: 'run',
    instruction: 'Crie um fluxo de autenticação.',
    useExistingAgents: true,
    allowNewAgents: true,
  };
  const propose = () =>
    service.invoke('canvas.autopilot.propose', request) as Promise<NexusAutopilotPlan>;
  return { service, repos, backend, chat, request, propose, starts: () => starts, defaultDraft };
}

it('gera e persiste uma prévia estruturada sem alterar agentes, tarefas ou execução', async () => {
  const { service, repos, propose, chat } = setup();
  const workers = repos.workers.list().length;
  const plan = await propose();
  expect(plan).toMatchObject({ version: 1, state: 'proposed', origin: 'autopilot' });
  expect(plan.draft.tasks.map((task) => task.key)).toEqual(['api', 'review']);
  expect(repos.tasks.list()).toHaveLength(0);
  expect(repos.workers.list()).toHaveLength(workers);
  expect(repos.runs.get('run')?.status).toBe('awaiting_plan_approval');
  expect(await service.invoke('canvas.autopilot.current', 'run')).toMatchObject([
    { id: plan.id, version: 1 },
  ]);
  expect(JSON.stringify(chat.mock.calls[0]?.[0].messages)).toContain('maxConcurrentTasks');
});

it('salva edição humana como nova versão e rejeita dependência circular', async () => {
  const { service, propose, defaultDraft } = setup();
  const first = await propose();
  const revised = (await service.invoke('canvas.autopilot.revise', {
    runId: 'run',
    planId: first.id,
    draft: {
      ...defaultDraft,
      tasks: defaultDraft.tasks.map((task) =>
        task.key === 'review' ? { ...task, title: 'Revisão de segurança' } : task,
      ),
    },
    changeSummary: 'Especializei a revisão.',
  })) as NexusAutopilotPlan;
  expect(revised).toMatchObject({ version: 2, origin: 'manual', basedOnPlanId: first.id });
  expect(
    (await service.invoke('canvas.autopilot.current', 'run')) as NexusAutopilotPlan[],
  ).toMatchObject([{ id: revised.id }, { id: first.id, state: 'superseded' }]);
  await expect(
    service.invoke('canvas.autopilot.revise', {
      runId: 'run',
      planId: revised.id,
      draft: {
        ...defaultDraft,
        tasks: [
          { ...defaultDraft.tasks[0]!, dependsOn: ['review'] },
          { ...defaultDraft.tasks[1]!, dependsOn: ['api'] },
        ],
      },
      changeSummary: 'Criar ciclo.',
    }),
  ).rejects.toThrow(/circular|dependência/i);
});

it('aplica pelo scheduler real, preserva dependências e torna retries idempotentes', async () => {
  const { service, repos, propose } = setup();
  const plan = await propose();
  const first = await service.invoke('canvas.autopilot.apply', {
    runId: 'run',
    planId: plan.id,
    start: false,
  });
  expect(first).toMatchObject({ createdAgents: 0, createdTasks: 2, started: false });
  expect(repos.tasks.list('run_id = ?', 'run')).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ key: 'api', dependsOn: [] }),
      expect.objectContaining({ key: 'review', dependsOn: ['api'] }),
    ]),
  );
  expect(repos.runs.get('run')?.status).toBe('awaiting_plan_approval');
  const retry = (await service.invoke('canvas.autopilot.apply', {
    runId: 'run',
    planId: plan.id,
    start: false,
  })) as NexusAutopilotApplyResult;
  expect(retry.alreadyApplied).toBe(true);
  expect(repos.tasks.list('run_id = ?', 'run')).toHaveLength(2);
});

it('cria agente com modelo realmente configurado e só inicia após aprovação explícita', async () => {
  const { service, repos, propose, starts } = setup(() => ({
    objective: 'Criar e executar uma revisão.',
    agents: [
      {
        source: 'new',
        key: 'reviewer',
        name: 'Security Reviewer',
        role: 'reviewer',
        providerId: 'provider',
        modelId: 'configured-model',
      },
    ],
    tasks: [
      {
        key: 'security',
        title: 'Revisar segurança',
        description: 'Revisar o fluxo.',
        workerKey: 'reviewer',
        dependsOn: [],
        acceptanceCriteria: ['Relatório produzido.'],
      },
    ],
    connectResult: true,
    approvalSteps: [],
    warnings: [],
  }));
  const before = repos.workers.list().length;
  const plan = await propose();
  const result = (await service.invoke('canvas.autopilot.apply', {
    runId: 'run',
    planId: plan.id,
    start: true,
  })) as NexusAutopilotApplyResult;
  expect(result.started).toBe(true);
  expect(starts()).toBe(1);
  expect(repos.workers.list()).toHaveLength(before + 1);
  const worker = repos.workers.list().find((item) => item.name === 'Security Reviewer');
  expect(worker).toMatchObject({ providerId: 'provider', modelId: 'configured-model' });
  expect(repos.tasks.list()[0]?.workerId).toBe(worker?.id);
  const retry = (await service.invoke('canvas.autopilot.apply', {
    runId: 'run',
    planId: plan.id,
    start: true,
  })) as NexusAutopilotApplyResult;
  expect(retry.alreadyApplied).toBe(true);
  expect(repos.workers.list()).toHaveLength(before + 1);
  expect(repos.tasks.list()).toHaveLength(1);
  expect(starts()).toBe(1);
});

it('rejeita operações fora do schema e não altera uma missão que já está executando', async () => {
  const invalid = setup((backendId) => ({
    objective: 'Inválido',
    agents: [{ source: 'existing', key: 'backend', workerId: backendId }],
    tasks: [
      {
        key: 'hack',
        title: 'Executar shell',
        description: 'Não permitido.',
        workerKey: 'backend',
        dependsOn: [],
        acceptanceCriteria: ['Nunca executar.'],
        command: 'rm -rf',
      },
    ],
    connectResult: true,
    approvalSteps: [],
    warnings: [],
  }));
  await expect(invalid.propose()).rejects.toThrow(/inválida|schema/i);
  expect(invalid.repos.tasks.list()).toHaveLength(0);

  const running = setup();
  const plan = await running.propose();
  running.repos.runs.put({ ...running.repos.runs.require('run', 'Execução'), status: 'running' });
  await expect(
    running.service.invoke('canvas.autopilot.apply', {
      runId: 'run',
      planId: plan.id,
      start: true,
    }),
  ).rejects.toThrow(/mudou desde a prévia|execução/i);
  expect(running.repos.tasks.list()).toHaveLength(0);
});
