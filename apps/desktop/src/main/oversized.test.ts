import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HiveDatabase } from '@hive/persistence';
import { boundForIpc } from './ipc-guard';
import { findOversized, repairOversized, shrinkStrings } from './oversized';

async function database() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hive-oversized-'));
  return new HiveDatabase(path.join(dir, 'hive.sqlite'));
}

const huge = 'diff --git a/node_modules/x b/node_modules/x\n' + 'y'.repeat(3 * 1024 * 1024);

describe('registros grandes demais', () => {
  it('acha, reduz e mantém o resto do registro igual', async () => {
    const db = await database();
    const task = { id: 'task_1', status: 'failed', error: huge, title: 'Tarefa' };
    db.db
      .prepare('INSERT INTO tasks (id, run_id, worker_id, updated_at, data) VALUES (?, ?, ?, ?, ?)')
      .run('task_1', 'run_1', null, 'x', JSON.stringify(task));
    db.db
      .prepare('INSERT INTO tasks (id, run_id, worker_id, updated_at, data) VALUES (?, ?, ?, ?, ?)')
      .run('task_2', 'run_1', null, 'x', JSON.stringify({ id: 'task_2', error: 'curto' }));
    db.db
      .prepare(
        "INSERT INTO events (id, ts, type, level, message, data) VALUES ('e1', 'x', 'error', 'error', ?, NULL)",
      )
      .run(huge);
    const found = findOversized(db);
    expect(found.map((record) => [record.table, record.id])).toEqual([
      ['tasks', 'task_1'],
      ['events', '1'],
    ]);
    repairOversized(db, found);
    expect(findOversized(db)).toEqual([]);
    const after = JSON.parse(
      (db.db.prepare("SELECT data FROM tasks WHERE id = 'task_1'").get() as { data: string }).data,
    );
    expect(after.title).toBe('Tarefa');
    expect(after.status).toBe('failed');
    expect(after.error.startsWith('diff --git a/node_modules/x')).toBe(true);
    expect(after.error).toContain('caracteres omitidos');
    expect(after.error.length).toBeLessThan(9_000);
    const other = db.db.prepare("SELECT data FROM tasks WHERE id = 'task_2'").get() as {
      data: string;
    };
    expect(JSON.parse(other.data).error).toBe('curto');
    db.close();
  });

  it('shrinkStrings só toca nos textos longos', () => {
    const value = { a: 'curto', b: ['x'.repeat(20_000)], c: 3, d: null };
    const out = shrinkStrings(value, 1_000) as typeof value;
    expect(out.a).toBe('curto');
    expect(out.b[0]!.length).toBeLessThan(1_100);
    expect(out.c).toBe(3);
    expect(out.d).toBeNull();
  });
});

describe('barreira do IPC', () => {
  it('corta só textos acima do limite e conta quantos', () => {
    const small = { list: [{ text: 'ok' }], n: 1 };
    const same = boundForIpc(small, 100);
    expect(same.value).toBe(small);
    expect(same.clipped).toBe(0);
    const big = { list: [{ text: 'z'.repeat(5_000) }, { text: 'ok' }], when: new Date(0) };
    const out = boundForIpc(big, 1_000);
    expect(out.clipped).toBe(1);
    expect(out.value.list[0]!.text.length).toBeLessThanOrEqual(1_000);
    expect(out.value.list[1]).toBe(big.list[1]);
    expect(out.value.when).toBe(big.when);
    // The original is never changed.
    expect(big.list[0]!.text.length).toBe(5_000);
  });
});
