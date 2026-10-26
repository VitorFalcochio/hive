import type { AgentEvent, Worker } from '@hive/core';

/** One scripted step: an event and how long after the previous one it happens. */
export interface DemoStep {
  after: number;
  event: AgentEvent;
}

/**
 * A made-up mission ("Login com Google") played on the comb with the user's own bees, so the
 * screen can be seen working before any provider is set up. Nothing runs and nothing is stored.
 */
export function demoScript(workers: Worker[]): { steps: DemoStep[]; keys: string[] } {
  const pick = (role: Worker['role'], skip: Worker[]) =>
    workers.find((worker) => worker.role === role && !skip.includes(worker)) ??
    workers.find((worker) => worker.role !== 'queen' && !skip.includes(worker)) ??
    workers[0];
  const front = pick('frontend', []);
  const back = pick('backend', front ? [front] : []);
  const qa = pick('qa', [front, back].filter(Boolean) as Worker[]);
  if (!front || !back || !qa) return { steps: [], keys: [] };

  const steps: DemoStep[] = [];
  let n = 0;
  const add = (
    after: number,
    task: string,
    worker: Worker,
    type: AgentEvent['type'],
    data: Record<string, unknown>,
    message = '',
  ) =>
    steps.push({
      after,
      event: {
        id: `demo-${++n}`,
        ts: '',
        workspaceId: null,
        runId: 'demo',
        taskId: `demo-${task}`,
        workerId: worker.id,
        type,
        level: 'info',
        message,
        data,
      },
    });
  const call = (
    after: number,
    task: string,
    worker: Worker,
    tool: string,
    args: object,
    extra = {},
  ) => add(after, task, worker, 'tool.call', { tool, args, ...extra });
  const change = (after: number, task: string, worker: Worker, path: string, created = false) =>
    add(after, task, worker, 'file.changed', { path, action: created ? 'created' : 'modified' });
  const state = (after: number, task: string, worker: Worker, value: string) =>
    add(after, task, worker, 'worker.state', { state: value });
  const tokens = (after: number, task: string, worker: Worker, amount: number) =>
    add(after, task, worker, 'model.response', {
      usage: { promptTokens: Math.round(amount * 0.9), completionTokens: Math.round(amount * 0.1) },
    });
  const scout = { soldier: 'scout' };

  add(200, 'front', front, 'session.started', {});
  add(150, 'back', back, 'session.started', {});
  call(900, 'front', front, 'read_file', { path: 'src/pages/Login.tsx' });
  call(500, 'back', back, 'read_file', { path: 'src/api/auth.ts' });
  tokens(300, 'front', front, 14_200);
  call(1400, 'back', back, 'call_soldiers', {}, {});
  steps.at(-1)!.event.message = 'Convocou Batedora';
  add(200, 'back', back, 'info', { ...scout, phase: 'start' });
  call(700, 'back', back, 'read_file', { path: 'src/db/users.ts' }, scout);
  call(600, 'front', front, 'write_file', { path: 'src/components/GoogleButton.tsx' });
  state(0, 'front', front, 'coding');
  change(900, 'front', front, 'src/components/GoogleButton.tsx', true);
  call(700, 'back', back, 'read_file', { path: 'src/config/env.ts' }, scout);
  tokens(200, 'back', back, 18_900);
  call(1000, 'back', back, 'read_file', { path: 'src/api/session.ts' }, scout);
  add(1100, 'back', back, 'info', { ...scout, phase: 'end' });
  call(500, 'front', front, 'replace_in_file', { path: 'src/pages/Login.tsx' });
  change(800, 'front', front, 'src/pages/Login.tsx');
  call(300, 'back', back, 'replace_in_file', { path: 'src/api/auth.ts' });
  state(0, 'back', back, 'coding');
  change(900, 'back', back, 'src/api/auth.ts');
  add(300, 'qa', qa, 'session.started', {});
  call(600, 'qa', qa, 'read_file', { path: 'tests/auth.test.ts' });
  call(500, 'back', back, 'replace_in_file', { path: 'src/db/users.ts' });
  change(800, 'back', back, 'src/db/users.ts');
  call(400, 'front', front, 'read_file', { path: 'src/styles/login.css' });
  tokens(200, 'qa', qa, 9_800);
  call(700, 'qa', qa, 'write_file', { path: 'tests/auth.test.ts' });
  change(800, 'qa', qa, 'tests/auth.test.ts');
  call(300, 'front', front, 'replace_in_file', { path: 'src/styles/login.css' });
  change(700, 'front', front, 'src/styles/login.css');
  call(500, 'back', back, 'write_file', { path: 'src/api/google.ts' });
  change(900, 'back', back, 'src/api/google.ts', true);
  call(400, 'qa', qa, 'run_command', { command: 'npm test' });
  state(0, 'qa', qa, 'waiting_approval');
  tokens(600, 'back', back, 21_400);
  state(2600, 'qa', qa, 'testing');
  call(0, 'qa', qa, 'run_command', { command: 'npm test' });
  add(2200, 'qa', qa, 'command.finished', { command: 'npm test', exitCode: 1 });
  call(900, 'front', front, 'read_file', { path: 'src/pages/Login.tsx' });
  call(800, 'front', front, 'replace_in_file', { path: 'src/pages/Login.tsx' });
  change(800, 'front', front, 'src/pages/Login.tsx');
  call(300, 'back', back, 'replace_in_file', { path: 'src/api/auth.ts' });
  change(800, 'back', back, 'src/api/auth.ts');
  tokens(200, 'front', front, 11_300);
  call(700, 'qa', qa, 'run_command', { command: 'npm test' });
  add(2000, 'qa', qa, 'command.finished', { command: 'npm test', exitCode: 0 });
  call(600, 'front', front, 'finish', {});
  call(500, 'back', back, 'finish', {});
  call(500, 'qa', qa, 'finish', {});
  return { steps, keys: ['demo-front', 'demo-back', 'demo-qa'] };
}
