import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, RuntimeEvent } from '@hive/agents';
import { HiveDatabase } from '@hive/persistence';
import {
  emptyCanvasLayout,
  type CanvasLayout,
  type CanvasSnapshot,
  type CanvasTerminal,
  type CanvasWorker,
  type HivePush,
  type ProviderConfig,
  type Task,
  type Worker,
  type LiveResult,
  type MissionNote,
} from '@hive/core';

vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.0' },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}));
import { DesktopService } from './service';

const databases: HiveDatabase[] = [];
const services: DesktopService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  for (const db of databases.splice(0)) db.close();
});

async function repository() {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'hive-canvas-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true });
  git('init', '-b', 'main');
  await writeFile(path.join(repo, 'README.md'), '# canvas\n');
  git('add', '.');
  git(
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@hive.local',
    '-c',
    'core.hooksPath=',
    'commit',
    '-m',
    'base',
  );
  return repo;
}

/** A project with one mission whose plan has one task, through the same calls the UI makes. */
async function setup(runtime?: AgentRuntime, file = ':memory:') {
  const db = new HiveDatabase(file);
  databases.push(db);
  const pushes: HivePush[] = [];
  const service = new DesktopService(db, os.tmpdir(), (push) => pushes.push(push), runtime);
  services.push(service);
  const repo = await repository();
  const at = new Date().toISOString();
  service.repos.workspaces.put({
    id: 'ws1',
    name: 'canvas',
    path: repo,
    defaultBranch: 'main',
    createdAt: at,
    lastOpenedAt: at,
  });
  const provider = (await service.invoke('provider.save', {
    kind: 'openai-compatible',
    name: 'Local',
    baseUrl: 'http://127.0.0.1:11434/v1',
    enabled: true,
  })) as ProviderConfig;
  const created = (await service.invoke('canvas.mission.create', {
    workspaceId: 'ws1',
    title: 'Checkout',
    objective: 'Pagamento',
  })) as { runId: string };
  const workers = (await service.invoke('worker.list', undefined)) as Worker[];
  const backend = workers.find((worker) => worker.role === 'backend')!;
  await service.invoke('canvas.worker.setModel', {
    workerId: backend.id,
    providerId: provider.id,
    modelId: 'modelo',
  });
  await service.invoke('run.setPlan', {
    runId: created.runId,
    plan: {
      notes: '',
      tasks: [
        {
          key: 'api',
          title: 'API',
          description: 'd',
          workerId: backend.id,
          dependsOn: [],
          acceptanceCriteria: ['ok'],
        },
      ],
    },
  });
  return { service, pushes, runId: created.runId, backend, provider, db };
}

describe('Nexus no processo principal', { timeout: 30_000 }, () => {
  it('reconstitui o serviço principal após reinicialização usando o banco em arquivo', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hive-canvas-restart-'));
    const file = path.join(directory, 'hive.db');
    const { service, runId, db } = await setup(undefined, file);
    const snapshot = (await service.invoke('canvas.snapshot', runId)) as CanvasSnapshot;
    const missionId = snapshot.detail.mission.id;
    const task = snapshot.detail.tasks[0]!;
    service.repos.appendEvent({
      id: 'restart-event',
      ts: new Date().toISOString(),
      workspaceId: snapshot.detail.run.workspaceId,
      runId,
      taskId: task.id,
      workerId: task.workerId,
      type: 'file.changed',
      level: 'info',
      message: 'Arquivo registrado',
      data: { path: 'persist.ts', action: 'created' },
    });
    const note = await service.invoke('canvas.notes.save', {
      missionId,
      text: '# Persistente',
      revision: 0,
    });
    const layout = {
      ...emptyCanvasLayout,
      pinned: { workspace: { [`result:${missionId}`]: { x: 1700, y: 350 } } },
    };
    await service.invoke('canvas.layout.save', { runId, layout });
    const report = await service.invoke('canvas.result.get', runId);
    service.dispose();
    services.splice(services.indexOf(service), 1);
    db.close();
    databases.splice(databases.indexOf(db), 1);
    const reopened = new HiveDatabase(file);
    databases.push(reopened);
    const restarted = new DesktopService(reopened, os.tmpdir(), () => {});
    services.push(restarted);
    expect(await restarted.invoke('canvas.result.get', runId)).toEqual(report);
    expect(await restarted.invoke('canvas.notes.get', missionId)).toEqual(note);
    expect(await restarted.invoke('canvas.layout.get', runId)).toEqual(layout);
    expect(
      (
        (await restarted.invoke('canvas.result.events', { runId })) as {
          events: { event: { id: string } }[];
        }
      ).events.some((item) => item.event.id === 'restart-event'),
    ).toBe(true);
  });
  it('continua executando com o Canvas fechado e recupera resultado, eventos, notas e layout', async () => {
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let started = false;
    let listener: ((event: RuntimeEvent) => void) | undefined;
    const runtime: AgentRuntime = {
      id: 'controlled',
      start: async (input) => {
        started = true;
        const done = waiting.then(async () => {
          await writeFile(
            path.join(input.worktreePath, 'auth.ts'),
            'export const authenticated = true;\n',
          );
          listener?.({
            type: 'file.changed',
            level: 'info',
            message: 'auth.ts',
            data: { path: 'auth.ts', action: 'created' },
          });
          listener?.({
            type: 'command.finished',
            level: 'info',
            message: 'teste',
            data: { command: 'npm test', exitCode: 0, outputTail: 'passed' },
          });
          return {
            status: 'completed' as const,
            summary: 'Auth pronta',
            error: null,
            steps: 1,
            usage: { promptTokens: 1, completionTokens: 1 },
            commands: [
              {
                command: 'npm test',
                exitCode: 0,
                durationMs: 1,
                timedOut: false,
                outputTail: 'passed',
              },
            ],
          };
        });
        return { id: input.sessionId, done };
      },
      cancel: vi.fn(async () => {}),
      subscribe: (_id, callback) => {
        listener = callback;
        return () => {
          listener = undefined;
        };
      },
    };
    const { service, pushes, runId } = await setup(runtime);
    const snapshot = (await service.invoke('canvas.snapshot', runId)) as CanvasSnapshot;
    const missionId = snapshot.detail.mission.id;
    const note = (await service.invoke('canvas.notes.save', {
      missionId,
      text: '# Observações manuais',
      revision: 0,
    })) as MissionNote;
    const layout = {
      ...emptyCanvasLayout,
      pinned: { workspace: { [`result:${missionId}`]: { x: 1234, y: 234 } } },
      sizes: { [`result:${missionId}`]: { width: 410, height: 250 } },
    };
    await service.invoke('canvas.layout.save', { runId, layout });
    await service.invoke('run.start', runId);
    await vi.waitFor(() => expect(started).toBe(true), { timeout: 15_000 });
    const during = (await service.invoke('canvas.result.get', runId)) as LiveResult;
    expect(during.active).toHaveLength(1);
    // Closing the renderer drops its subscriptions; no scheduler cancellation is called.
    pushes.length = 0;
    finish();
    await vi.waitFor(() => expect(service.repos.runs.get(runId)?.status).toBe('review'), {
      timeout: 15_000,
    });
    await vi.waitFor(() => expect(service.repos.getLiveResult(runId)?.completed).toHaveLength(1), {
      timeout: 3000,
    });
    const reopened = (await service.invoke('canvas.result.get', runId)) as LiveResult;
    expect(reopened.files).toMatchObject([{ path: 'auth.ts' }]);
    expect(reopened.tests).toMatchObject([{ status: 'passed' }]);
    expect(reopened.updates.some((update) => update.verified && update.eventId)).toBe(true);
    expect(await service.invoke('canvas.notes.get', missionId)).toEqual(note);
    expect(await service.invoke('canvas.layout.get', runId)).toEqual(layout);
    expect(
      ((await service.invoke('canvas.result.events', { runId })) as { events: unknown[] }).events
        .length,
    ).toBeGreaterThan(0);
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect(pushes.some((push) => push.kind === 'changed' && push.entity === 'result')).toBe(true);
  });
  it('guarda o layout espacial à parte da execução e ignora um layout corrompido', async () => {
    const { service, runId } = await setup();
    expect(await service.invoke('canvas.layout.get', runId)).toEqual(emptyCanvasLayout);
    const layout: CanvasLayout = {
      ...emptyCanvasLayout,
      pinned: { workspace: { 'task:x': { x: 10, y: 20, locked: true } } },
      notes: [{ id: 'note:1', text: 'Revisar o login', x: 0, y: 0, tone: 'gold' }],
      agents: ['worker_1'],
    };
    await service.invoke('canvas.layout.save', { runId, layout });
    expect(await service.invoke('canvas.layout.get', runId)).toEqual(layout);
    // Moving things on the canvas never touched the plan.
    const snapshot = (await service.invoke('canvas.snapshot', runId)) as CanvasSnapshot;
    expect(snapshot.detail.tasks.map((task) => task.key)).toEqual(['api']);
    service.repos.setValue(`canvasLayout:${runId}`, '{"version":9}');
    expect(await service.invoke('canvas.layout.get', runId)).toEqual(emptyCanvasLayout);
  });

  it('tarefas, dependências e delegações do canvas passam pelo motor', async () => {
    const { service, runId, backend } = await setup();
    const added = (await service.invoke('canvas.task.create', {
      runId,
      task: {
        key: 'ui',
        title: 'Tela',
        description: 'Tela de pagamento',
        workerId: null,
        dependsOn: ['api'],
        acceptanceCriteria: ['abre'],
      },
    })) as Task;
    expect(added).toMatchObject({ status: 'pending', dependsOn: ['api'] });
    const api = (await service.invoke('canvas.snapshot', runId)) as CanvasSnapshot;
    const apiTask = api.detail.tasks.find((task) => task.key === 'api')!;
    await expect(
      service.invoke('canvas.task.link', {
        taskId: apiTask.id,
        dependsOnTaskId: added.id,
        linked: true,
      }),
    ).rejects.toThrow(/ciclo/);
    const assigned = (await service.invoke('canvas.task.assign', {
      taskId: added.id,
      workerId: backend.id,
    })) as Task;
    expect(assigned.workerId).toBe(backend.id);
    const queen = ((await service.invoke('worker.list', undefined)) as Worker[]).find(
      (worker) => worker.role === 'queen',
    )!;
    await expect(
      service.invoke('canvas.task.assign', { taskId: added.id, workerId: queen.id }),
    ).rejects.toThrow(/Queen/);
  });

  it('cria agentes a partir de um papel, sem expor prompts', async () => {
    const { service, provider } = await setup();
    const created = (await service.invoke('canvas.worker.create', {
      name: 'Pagamentos',
      role: 'backend',
      providerId: provider.id,
      modelId: 'modelo',
    })) as CanvasWorker;
    expect(created).toMatchObject({ name: 'Pagamentos', role: 'backend', modelId: 'modelo' });
    expect(Object.keys(created)).not.toContain('systemPrompt');
    const stored = service.repos.workers.require(created.id, 'Agente');
    expect(stored.systemPrompt.length).toBeGreaterThan(0);
  });

  it('o canvas só controla os terminais que ele abriu', async () => {
    const { service, runId, backend } = await setup();
    await expect(
      service.invoke('canvas.terminal.open', {
        runId,
        workerId: service.repos.workers.list().find((w) => w.role === 'qa')!.id,
        kind: 'chat',
      }),
    ).rejects.toThrow(/provedor e modelo/);
    const opened = (await service.invoke('canvas.terminal.open', {
      runId,
      workerId: backend.id,
      kind: 'shell',
    })) as CanvasTerminal;
    expect(opened).toMatchObject({ workerId: backend.id, kind: 'shell', taskId: null });
    expect(service.isCanvasTerminal(opened.session.id)).toBe(true);
    const other = (await service.invoke('terminal.start', { command: '' }).catch(() => null)) as {
      id: string;
    } | null;
    if (other) expect(service.isCanvasTerminal(other.id)).toBe(false);
    const snapshot = (await service.invoke('canvas.snapshot', runId)) as CanvasSnapshot;
    expect(snapshot.terminals.map((item) => item.session.id)).toEqual([opened.session.id]);
    await service.invoke('terminal.stop', opened.session.id);
  });
});
