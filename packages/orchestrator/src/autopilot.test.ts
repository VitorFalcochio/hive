import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, type Run, type RunStatus } from '@hive/core';
import { HiveDatabase, Repositories } from '@hive/persistence';
import { Autopilot, type AutopilotHistoryItem } from './autopilot';

const databases: HiveDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const at = new Date().toISOString();

function setup() {
  const db = new HiveDatabase(':memory:');
  databases.push(db);
  const repos = new Repositories(db);
  repos.saveSettings({
    ...defaultSettings,
    autopilot: { ...defaultSettings.autopilot, enabled: true },
  });
  repos.workspaces.put({
    id: 'ws',
    name: 'repo',
    path: '/repo',
    defaultBranch: 'main',
    createdAt: at,
    lastOpenedAt: at,
  });
  const addRun = (id: string, status: RunStatus = 'draft', withTask = false) => {
    repos.missions.put({
      id: `m_${id}`,
      workspaceId: 'ws',
      title: `Missão ${id}`,
      objective: 'x',
      createdAt: at,
    });
    const run: Run = {
      id,
      missionId: `m_${id}`,
      workspaceId: 'ws',
      status,
      baseBranch: 'main',
      baseCommit: 'abc',
      queenWorkerId: null,
      planNotes: null,
      report: null,
      error: null,
      createdAt: at,
      finishedAt: null,
    };
    repos.runs.put(run);
    if (withTask) addTask(id, 'failed');
    return run;
  };
  const addTask = (runId: string, status: 'pending' | 'failed' | 'completed') =>
    repos.tasks.put({
      id: `task_${runId}`,
      runId,
      key: 'a',
      title: 'Tarefa',
      description: 'd',
      workerId: null,
      dependsOn: [],
      acceptanceCriteria: ['ok'],
      status,
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
    });
  const setStatus = (id: string, status: RunStatus) =>
    repos.runs.put({ ...repos.runs.require(id, 'Execução'), status });
  const plan = vi.fn(async (runId: string) => {
    addTask(runId, 'pending');
    setStatus(runId, 'awaiting_plan_approval');
  });
  const start = vi.fn((runId: string) => setStatus(runId, 'running'));
  const finished: AutopilotHistoryItem[] = [];
  const pilot = new Autopilot({
    repos,
    plan,
    start,
    onChange: () => undefined,
    onFinished: (item) => finished.push(item),
  });
  return { repos, pilot, plan, start, finished, addRun, setStatus };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('Autopilot', () => {
  it('planeja e inicia a primeira missão e espera ela terminar para passar à próxima', async () => {
    const ctx = setup();
    ctx.addRun('r1');
    ctx.addRun('r2');
    ctx.pilot.enqueue('r1');
    ctx.pilot.enqueue('r2');
    await settle();
    expect(ctx.plan.mock.calls.map(([id]) => id)).toEqual(['r1']);
    expect(ctx.start.mock.calls.map(([id]) => id)).toEqual(['r1']);
    expect(ctx.pilot.current()).toBe('r1');
    expect(ctx.pilot.isUnattended('r1')).toBe(true);

    ctx.setStatus('r1', 'review');
    ctx.pilot.tick();
    await settle();
    expect(ctx.finished.map((item) => [item.runId, item.status])).toEqual([['r1', 'review']]);
    expect(ctx.start.mock.calls.map(([id]) => id)).toEqual(['r1', 'r2']);
    expect(ctx.pilot.queue()).toEqual(['r2']);
    expect(ctx.pilot.isUnattended('r1')).toBe(false);
  });

  it('registra a falha do planejamento e segue para a próxima missão', async () => {
    const ctx = setup();
    ctx.addRun('r1');
    ctx.addRun('r2');
    ctx.plan.mockImplementationOnce(async () => {
      throw new Error('Queen sem modelo');
    });
    ctx.pilot.enqueue('r1');
    ctx.pilot.enqueue('r2');
    await settle();
    expect(ctx.finished).toMatchObject([
      { runId: 'r1', status: 'failed', error: 'Queen sem modelo' },
    ]);
    expect(ctx.pilot.current()).toBe('r2');
    expect(ctx.pilot.history()[0]?.missionTitle).toBe('Missão r1');
  });

  it('retoma uma vez a missão interrompida por um reinício', async () => {
    const ctx = setup();
    ctx.addRun('r1', 'failed', true);
    ctx.repos.setValue('autopilotQueue', JSON.stringify(['r1']));
    ctx.pilot.tick();
    await settle();
    expect(ctx.plan).not.toHaveBeenCalled();
    expect(ctx.start.mock.calls.map(([id]) => id)).toEqual(['r1']);

    // It fails again in this session: now it is finished, not resumed forever.
    ctx.setStatus('r1', 'failed');
    ctx.pilot.tick();
    await settle();
    expect(ctx.start).toHaveBeenCalledTimes(1);
    expect(ctx.finished.map((item) => item.status)).toEqual(['failed']);
  });

  it('não faz nada com o turno desligado', async () => {
    const ctx = setup();
    ctx.repos.saveSettings(defaultSettings);
    ctx.addRun('r1');
    ctx.pilot.enqueue('r1');
    await settle();
    expect(ctx.plan).not.toHaveBeenCalled();
    expect(ctx.pilot.isUnattended('r1')).toBe(false);
    expect(ctx.pilot.queue()).toEqual(['r1']);
  });

  it('reordena só as missões que ainda esperam', async () => {
    const ctx = setup();
    for (const id of ['r1', 'r2', 'r3']) ctx.addRun(id);
    for (const id of ['r1', 'r2', 'r3']) ctx.pilot.enqueue(id);
    await settle();
    ctx.pilot.move('r3', -1);
    expect(ctx.pilot.queue()).toEqual(['r1', 'r3', 'r2']);
    // r1 is running, so nothing takes its place.
    ctx.pilot.move('r3', -1);
    expect(ctx.pilot.queue()).toEqual(['r1', 'r3', 'r2']);
    ctx.pilot.dequeue('r2');
    expect(ctx.pilot.queue()).toEqual(['r1', 'r3']);
  });
});
