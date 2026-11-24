import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Requirement, Run, RunDelivery, Task } from '@hive/core';
import type { Repositories } from '@hive/persistence';
import { DeliveryGate, assessRequirements, deliveryFingerprint } from './delivery';

vi.mock('electron', () => ({}));

const task = (overrides: Partial<Task>): Task =>
  ({
    id: overrides.key ?? 't',
    runId: 'run',
    key: 't',
    title: 'Tarefa',
    description: 'd',
    workerId: 'w',
    dependsOn: [],
    acceptanceCriteria: ['ok'],
    status: 'completed',
    branch: null,
    result: null,
    error: null,
    createdAt: '2026-11-24T10:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    ...overrides,
  }) as Task;

const requirements: Requirement[] = [
  { id: 'R1', text: 'Dashboard em tempo real' },
  { id: 'R2', text: 'Lista de processos' },
  { id: 'R3', text: 'README' },
];

describe('status de cada requisito', () => {
  const tasks = [
    task({ key: 'dash', title: 'Dashboard', covers: ['R1'] }),
    task({ key: 'procs', title: 'Processos', covers: ['R2'], status: 'failed' }),
  ];

  it('só é "entregue" com a tarefa concluída e a verificação final passando', () => {
    const passed = assessRequirements(requirements, tasks, { passed: true, detail: '' });
    expect(passed.map((item) => item.status)).toEqual(['met', 'pending', 'uncovered']);
    expect(passed[1]!.reason).toContain('“Processos” (falhou)');
    expect(passed[2]!.reason).toContain('Nenhuma tarefa');
    const failed = assessRequirements(requirements, tasks, {
      passed: false,
      detail: 'a verificação final falhou em "npm run build".',
    });
    // Done is not delivered: without a passing check it is only "unverified".
    expect(failed[0]).toMatchObject({ status: 'unverified' });
    expect(failed[0]!.reason).toContain('npm run build');
  });

  it('a impressão digital muda quando muda o trabalho terminado', () => {
    const a = [task({ key: 'a', result: { commit: '111' } as Task['result'] })];
    const b = [task({ key: 'a', result: { commit: '222' } as Task['result'] })];
    expect(deliveryFingerprint(a)).not.toBe(deliveryFingerprint(b));
    expect(deliveryFingerprint([task({ key: 'a', status: 'failed' })])).toBe('');
  });
});

/** A real repository, with a task branch per piece of work, and the gate around it. */
async function setup(script: string) {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'hive-delivery-'));
  const git = (args: string[]) =>
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@hive.local', ...args], {
      cwd: repo,
      windowsHide: true,
    })
      .toString()
      .trim();
  git(['init', '-b', 'main']);
  await writeFile(
    path.join(repo, 'package.json'),
    JSON.stringify({ name: 'x', private: true, scripts: { check: script } }),
  );
  await writeFile(path.join(repo, '.gitignore'), 'node_modules\n');
  // Installed dependencies the checkout borrows, so the gate does not run an install.
  await mkdir(path.join(repo, 'node_modules'));
  git(['add', '.']);
  git(['-c', 'core.hooksPath=', 'commit', '-m', 'base']);
  const base = git(['rev-parse', 'HEAD']);
  const branch = async (name: string, file: string, content: string) => {
    git(['checkout', '-q', '-b', name, base]);
    await writeFile(path.join(repo, file), content);
    git(['add', file]);
    git(['-c', 'core.hooksPath=', 'commit', '-m', name]);
    const commit = git(['rev-parse', 'HEAD']);
    git(['checkout', '-q', 'main']);
    return commit;
  };
  const values = new Map<string, string>();
  const tasks: Task[] = [];
  const repos = {
    getValue: (key: string) => values.get(key) ?? null,
    setValue: (key: string, value: string) => values.set(key, value),
    tasks: { list: () => tasks },
    workspaces: { require: () => ({ id: 'ws', path: repo }) },
    missions: { get: () => ({ title: 'Pulse' }) },
  } as unknown as Repositories;
  const notify = vi.fn();
  const gate = new DeliveryGate({
    repos,
    worktreeRoot: () => path.join(repo, '..', `${path.basename(repo)}-worktrees`),
    commands: async () => [],
    onChange: () => undefined,
    log: () => undefined,
    notify,
  });
  const run = { id: 'run', workspaceId: 'ws', missionId: 'm', status: 'review', baseCommit: base };
  const settled = async (): Promise<RunDelivery> => {
    gate.onRun(run as Run);
    for (let i = 0; i < 300; i++) {
      const delivery = gate.get('run');
      if (delivery && delivery.status !== 'checking') return delivery;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('A porta de entrega não terminou.');
  };
  return { gate, tasks, branch, settled, notify };
}

describe('porta final de entrega', { timeout: 60_000 }, () => {
  it('junta o trabalho de todas as tarefas e só passa com as partes juntas', async () => {
    // Passes only when both pieces are in the same tree.
    const { gate, tasks, branch, settled, notify } = await setup(
      "node -e \"const f=require('fs');f.accessSync('a.txt');f.accessSync('b.txt')\"",
    );
    const a = await branch('task-a', 'a.txt', 'a');
    const b = await branch('task-b', 'b.txt', 'b');
    tasks.push(
      task({
        key: 'a',
        title: 'Parte A',
        covers: ['R1'],
        branch: 'task-a',
        result: { commit: a } as Task['result'],
        finishedAt: '1',
      }),
      task({
        key: 'b',
        title: 'Parte B',
        covers: ['R2'],
        branch: 'task-b',
        result: { commit: b } as Task['result'],
        finishedAt: '2',
      }),
    );
    gate.saveExtras('run', { requirements: requirements.slice(0, 2), verify: ['npm run check'] });
    const delivery = await settled();
    expect(delivery.problem).toBeNull();
    expect(delivery.checks).toEqual([
      expect.objectContaining({ command: 'npm run check', ok: true }),
    ]);
    expect(delivery.status).toBe('verified');
    expect(delivery.requirements.map((item) => item.status)).toEqual(['met', 'met']);
    expect(delivery.summary).toContain('2 de 2 requisitos');
    expect(notify).toHaveBeenCalledWith('Missão pronta e verificada', expect.any(String));
  });

  it('partes que não se juntam deixam a entrega com pendências e dizem onde', async () => {
    const { gate, tasks, branch, settled } = await setup('node -e "process.exit(0)"');
    const a = await branch('task-a', 'same.txt', 'versão A');
    const b = await branch('task-b', 'same.txt', 'versão B');
    tasks.push(
      task({
        key: 'a',
        title: 'Parte A',
        covers: ['R1'],
        branch: 'task-a',
        result: { commit: a } as Task['result'],
        finishedAt: '1',
      }),
      task({
        key: 'b',
        title: 'Parte B',
        covers: ['R2'],
        branch: 'task-b',
        result: { commit: b } as Task['result'],
        finishedAt: '2',
      }),
    );
    gate.saveExtras('run', { requirements: requirements.slice(0, 2), verify: ['npm run check'] });
    const delivery = await settled();
    expect(delivery.status).toBe('pending');
    expect(delivery.problem).toContain('“Parte B” não se junta');
    expect(delivery.problem).toContain('same.txt');
    expect(delivery.requirements.map((item) => item.status)).toEqual(['unverified', 'unverified']);
  });

  it('um comando que falha não deixa nada passar como entregue', async () => {
    const { gate, tasks, branch, settled } = await setup('node -e "process.exit(1)"');
    const a = await branch('task-a', 'a.txt', 'a');
    tasks.push(
      task({
        key: 'a',
        title: 'Parte A',
        covers: ['R1'],
        branch: 'task-a',
        result: { commit: a } as Task['result'],
        finishedAt: '1',
      }),
    );
    gate.saveExtras('run', {
      requirements: requirements.slice(0, 1),
      verify: ['npm run check', 'rm -rf /'],
    });
    const delivery = await settled();
    expect(delivery.status).toBe('pending');
    // The dangerous command never runs.
    expect(delivery.checks.map((check) => check.command)).toEqual(['npm run check']);
    expect(delivery.requirements[0]).toMatchObject({ status: 'unverified' });
  });
});
