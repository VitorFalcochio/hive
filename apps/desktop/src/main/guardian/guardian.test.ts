import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { ResourceUsage, Task } from '@hive/core';
import type { Repositories } from '@hive/persistence';
import { Guardian, redactReport } from './guardian';

vi.mock('electron', () => ({}));

const usage: ResourceUsage = {
  cpuPercent: 5,
  memoryMb: 400,
  processes: [],
  systemFreeMb: 8_000,
  systemTotalMb: 16_000,
  diskFreeMb: 50_000,
};

function setup(tasks: Task[] = []) {
  const values = new Map<string, string>();
  const repos = {
    getValue: (key: string) => values.get(key) ?? null,
    setValue: (key: string, value: string) => values.set(key, value),
    runs: { list: () => [] },
    workspaces: { list: () => [] },
    workers: { list: () => [{ id: 'w1', name: 'Ana' }] },
    tasks: {
      list: () => tasks,
      require: (id: string) => {
        const found = tasks.find((task) => task.id === id);
        if (!found) throw new Error('Tarefa não encontrada');
        return found;
      },
    },
    queryEvents: () => [],
  } as unknown as Repositories;
  let resting = [{ key: 'groq\u0000gpt-oss', untilMs: 60_000 }];
  const scheduler = {
    retry: vi.fn((id: string) => {
      const found = tasks.find((task) => task.id === id)!;
      found.status = 'pending';
    }),
    cancelTask: vi.fn(),
    leftoverWorktrees: vi.fn(async () => []),
    pruneWorktrees: vi.fn(async () => ({ removed: 2, kept: 1 })),
  };
  const resources = vi.fn(async () => usage);
  const guardian = new Guardian({
    repos,
    routes: {
      resting: () => resting,
      reset: () => {
        const count = resting.length;
        resting = [];
        return count;
      },
    },
    scheduler,
    resources,
    backup: async () => ({ name: 'manual-1.zip' }),
    reloadWindows: () => 2,
    save: async () => null,
    onChange: () => undefined,
  });
  return { guardian, scheduler, resources };
}

const failed = (): Task =>
  ({
    id: 't1',
    runId: 'r1',
    key: 't1',
    title: 'Tela',
    workerId: 'w1',
    status: 'failed',
    finishedAt: new Date().toISOString(),
    error: 'Provider error 413',
  }) as Task;

describe('Hive Guardian', () => {
  it('abre um incidente por problema, sem duplicar, e resolve quando passa', async () => {
    const { guardian } = setup();
    await guardian.diagnose();
    await guardian.diagnose();
    const resting = guardian
      .snapshot()
      .incidents.filter((item) => item.key === 'providers:resting');
    expect(resting).toHaveLength(1);
    expect(resting[0]!.resolvedAt).toBeNull();
    expect(guardian.snapshot().status).toBe('warn');
    await guardian.recover({ action: 'reset-providers' });
    await guardian.diagnose();
    const after = guardian.snapshot();
    expect(
      after.incidents.find((item) => item.key === 'providers:resting')!.resolvedAt,
    ).not.toBeNull();
    expect(after.recoveries[0]).toMatchObject({ action: 'reset-providers', ok: true });
    expect(after.recoveries[0]!.detail).toContain('1 modelo');
  });

  it('uma checagem que quebra vira achado e não impede as outras', async () => {
    const { guardian, resources } = setup();
    resources.mockRejectedValueOnce(new Error('sem métricas'));
    const snapshot = await guardian.diagnose();
    expect(snapshot.checks.find((check) => check.id === 'resources')).toMatchObject({
      status: 'fail',
    });
    expect(snapshot.checks.find((check) => check.id === 'database')!.status).toBe('ok');
    expect(snapshot.incidents.some((item) => item.key === 'check:resources')).toBe(true);
  });

  it('recuperações são idempotentes e ficam registradas', async () => {
    const tasks = [failed()];
    const { guardian, scheduler } = setup(tasks);
    const first = await guardian.recover({ action: 'retry-task', target: 't1' });
    const second = await guardian.recover({ action: 'retry-task', target: 't1' });
    expect(first.detail).toContain('voltou para a fila');
    // Already back in the queue: nothing done twice.
    expect(second.detail).toContain('nada a fazer');
    expect(scheduler.retry).toHaveBeenCalledOnce();
    const pruned = await guardian.recover({ action: 'prune-worktrees' });
    expect(pruned.detail).toContain('1 com alterações não salvas foram mantidas');
    const missing = await guardian.recover({ action: 'cancel-task', target: 'nao-existe' });
    expect(missing.ok).toBe(false);
    expect(guardian.snapshot().recoveries).toHaveLength(4);
  });

  it('o relatório não leva chaves, tokens nem a pasta e o nome do usuário', () => {
    const home = os.homedir();
    const text = redactReport(
      `chave sk-ant-api03-${'a'.repeat(40)} token ghp_${'b'.repeat(36)} em ${home}\\projeto do joaosilva`,
      home,
      'joaosilva',
    );
    expect(text).not.toContain('sk-ant-api03');
    expect(text).not.toContain('ghp_');
    expect(text).not.toContain(home);
    expect(text).not.toContain('joaosilva');
    expect(text).toContain('~');
  });
});
