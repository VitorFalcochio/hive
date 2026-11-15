import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HiveDatabase, SCHEMA_VERSION } from '@hive/persistence';
import {
  applyPendingRestore,
  autoBackupDue,
  backupName,
  backupsDir,
  createBackup,
  inspectBackup,
  listBackups,
  prune,
  resolveBackup,
  stageRestore,
} from './backup';

let dataDir: string;
const dbFile = () => path.join(dataDir, 'hive.sqlite');

async function seed(value: string) {
  const db = new HiveDatabase(dbFile());
  db.run(
    `INSERT INTO settings (key, value) VALUES ('marker', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    value,
  );
  db.close();
}

function marker(): string | undefined {
  const db = new HiveDatabase(dbFile());
  try {
    return db.get<{ value: string }>(`SELECT value FROM settings WHERE key = 'marker'`)?.value;
  } finally {
    db.close();
  }
}

async function backupTo(target: string) {
  const db = new HiveDatabase(dbFile());
  try {
    return await createBackup(db, dataDir, target, '1.0.0');
  } finally {
    db.close();
  }
}

const safetyCopy = (target: string) => backupTo(target).then(() => undefined);

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'hive-backup-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('backup', () => {
  it('copies the database and the skills library, and restores both', async () => {
    await seed('before');
    await mkdir(path.join(dataDir, 'skills', 'minha-skill'), { recursive: true });
    await writeFile(path.join(dataDir, 'skills', 'minha-skill', 'SKILL.md'), '# Minha skill');
    const file = path.join(dataDir, 'export.hive-backup');
    const meta = await backupTo(file);
    expect(meta).toMatchObject({ appVersion: '1.0.0', schemaVersion: SCHEMA_VERSION, files: 1 });

    // Things change after the backup...
    await seed('after');
    await rm(path.join(dataDir, 'skills'), { recursive: true });
    await mkdir(path.join(dataDir, 'skills', 'outra'), { recursive: true });
    await writeFile(path.join(dataDir, 'skills', 'outra', 'SKILL.md'), 'nova');

    // ...and the restore brings back the backup's state at the next start.
    await stageRestore(dataDir, file, SCHEMA_VERSION);
    expect(await applyPendingRestore(dataDir, safetyCopy)).toBe(true);
    expect(marker()).toBe('before');
    expect(await readFile(path.join(dataDir, 'skills', 'minha-skill', 'SKILL.md'), 'utf8')).toBe(
      '# Minha skill',
    );
    expect(existsSync(path.join(dataDir, 'skills', 'outra'))).toBe(false);

    // The data from before the restore is kept, and the restored database has no backup tables.
    const kept = await listBackups(backupsDir(dataDir));
    expect(kept.map((item) => item.kind)).toEqual(['pre-restore']);
    const db = new DatabaseSync(dbFile());
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'hive_backup%'`)
      .all();
    db.close();
    expect(tables).toEqual([]);
    expect(await applyPendingRestore(dataDir, safetyCopy)).toBe(false);
  });

  it('refuses files that are not Hive backups, and backups from a newer schema', async () => {
    const plain = path.join(dataDir, 'plain.sqlite');
    new DatabaseSync(plain).close();
    expect(() => inspectBackup(plain, SCHEMA_VERSION)).toThrow('não é um backup do Hive');

    const text = path.join(dataDir, 'text.hive-backup');
    await writeFile(text, 'hello');
    expect(() => inspectBackup(text, SCHEMA_VERSION)).toThrow();

    await seed('x');
    const file = path.join(dataDir, 'new.hive-backup');
    await backupTo(file);
    expect(() => inspectBackup(file, SCHEMA_VERSION - 1)).toThrow('versão mais nova');
  });

  it('never writes skill files outside the skills folder', async () => {
    await seed('x');
    const file = path.join(dataDir, 'evil.hive-backup');
    await backupTo(file);
    const db = new DatabaseSync(file);
    db.prepare(`INSERT INTO hive_backup_files (path, content) VALUES (?, ?)`).run(
      '../escaped.txt',
      Buffer.from('nope'),
    );
    db.close();
    await stageRestore(dataDir, file, SCHEMA_VERSION);
    await applyPendingRestore(dataDir, safetyCopy);
    expect(existsSync(path.join(dataDir, 'escaped.txt'))).toBe(false);
  });

  it('keeps the newest automatic backups and knows when one is due', async () => {
    const dir = backupsDir(dataDir);
    expect(await autoBackupDue(dir)).toBe(true);
    await mkdir(dir, { recursive: true });
    const day = 24 * 60 * 60 * 1000;
    for (let index = 0; index < 4; index++) {
      const date = new Date(Date.now() - index * day - 1000);
      const name = backupName('auto', date);
      await writeFile(path.join(dir, name), 'x');
      await utimes(path.join(dir, name), date, date);
    }
    await writeFile(path.join(dir, backupName('manual')), 'x');
    expect(await autoBackupDue(dir)).toBe(false);
    await prune(dir, 'auto', 2);
    const left = await readdir(dir);
    expect(left.filter((name) => name.startsWith('auto-'))).toHaveLength(2);
    expect(left.filter((name) => name.startsWith('manual-'))).toHaveLength(1);
    expect(await autoBackupDue(dir, Date.now() + 2 * day)).toBe(true);
  });

  it('only resolves plain backup names inside the backups folder', async () => {
    const dir = backupsDir(dataDir);
    expect(() => resolveBackup(dir, '../hive.sqlite')).toThrow('inválido');
    expect(() => resolveBackup(dir, 'x.txt')).toThrow('inválido');
    expect(() => resolveBackup(dir, 'auto-x.hive-backup')).toThrow('não encontrado');
  });
});
