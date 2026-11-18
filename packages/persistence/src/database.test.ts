import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { HiveDatabase, SCHEMA_VERSION } from './database';

it('renomeia para Nectar só os blocos com o nome padrão do antigo Cortex, sem perder dados', async () => {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'hive-db-')), 'hive.sqlite');
  const names = [
    'Cortex',
    'Cortex 2',
    'Cortex 12',
    'Cortex 2 backend',
    'Memória do login',
    'Cortexx',
  ];
  const before = new HiveDatabase(file);
  names.forEach((name, index) =>
    before.run(
      'INSERT INTO cortex_nodes (id, workspace_id, updated_at, data) VALUES (?, ?, ?, ?)',
      `n${index}`,
      'w',
      '2026-01-01',
      JSON.stringify({ id: `n${index}`, name, memories: 3 }),
    ),
  );
  // Back to the version before the rename, as a database from Hive 0.2.2 would be.
  before.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
  before.close();

  const after = new HiveDatabase(file);
  const rows = after.all<{ data: string }>('SELECT data FROM cortex_nodes ORDER BY id');
  after.close();
  expect(rows.map((row) => JSON.parse(row.data) as { name: string; memories: number })).toEqual([
    { id: 'n0', name: 'Nectar', memories: 3 },
    { id: 'n1', name: 'Nectar 2', memories: 3 },
    { id: 'n2', name: 'Nectar 12', memories: 3 },
    { id: 'n3', name: 'Cortex 2 backend', memories: 3 },
    { id: 'n4', name: 'Memória do login', memories: 3 },
    { id: 'n5', name: 'Cortexx', memories: 3 },
  ]);
});
