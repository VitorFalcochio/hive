import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BackupInfo } from '@hive/core';
import type { HiveDatabase } from '@hive/persistence';
import { HiveError, errorMessage } from '@hive/shared';

/**
 * A backup is one SQLite file: a consistent copy of hive.sqlite (VACUUM INTO, safe while Hive
 * runs) plus two extra tables, one with metadata and one with the skills library files. One
 * file is easy to move to another computer, and needs no archive library.
 *
 * API keys travel encrypted with the Windows account (safeStorage); on another account or
 * computer they cannot be read and must be entered again.
 */
export const BACKUP_EXTENSION = 'hive-backup';
const PENDING = `restore-pending.${BACKUP_EXTENSION}`;
const META = 'hive_backup';
const FILES = 'hive_backup_files';
const DB_FILE = 'hive.sqlite';
/** Copies taken just before a restore, kept so a restore can be undone. */
const KEEP_PRE_RESTORE = 3;

export interface BackupMeta {
  createdAt: string;
  appVersion: string;
  schemaVersion: number;
  files: number;
}

export function backupsDir(dataDir: string): string {
  return path.join(dataDir, 'backups');
}

function skillsDir(dataDir: string): string {
  return path.join(dataDir, 'skills');
}

/** `auto-2026-11-14T00-12-05.hive-backup`: sorts by time and is safe on every file system. */
export function backupName(kind: BackupInfo['kind'], date = new Date()): string {
  // Local time, as the user reads it in the backups folder.
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return `${kind}-${stamp}.${BACKUP_EXTENSION}`;
}

async function listFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)));
}

/** Writes a backup of the open database and the skills library to `target`. */
export async function createBackup(
  database: HiveDatabase,
  dataDir: string,
  target: string,
  appVersion: string,
): Promise<BackupMeta> {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  await rm(temp, { force: true });
  database.db.prepare('VACUUM INTO ?').run(temp);
  const skills = skillsDir(dataDir);
  const files = await listFiles(skills);
  const meta: BackupMeta = {
    createdAt: new Date().toISOString(),
    appVersion,
    schemaVersion: Number(
      (database.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    ),
    files: files.length,
  };
  const copy = new DatabaseSync(temp);
  try {
    copy.exec(
      `CREATE TABLE ${META} (key TEXT PRIMARY KEY, value TEXT NOT NULL);
       CREATE TABLE ${FILES} (path TEXT PRIMARY KEY, content BLOB NOT NULL);`,
    );
    copy.prepare(`INSERT INTO ${META} (key, value) VALUES ('meta', ?)`).run(JSON.stringify(meta));
    const insert = copy.prepare(`INSERT INTO ${FILES} (path, content) VALUES (?, ?)`);
    copy.exec('BEGIN');
    for (const file of files)
      insert.run(file.split(path.sep).join('/'), await readFile(path.join(skills, file)));
    copy.exec('COMMIT');
  } catch (error) {
    copy.close();
    await rm(temp, { force: true });
    throw error;
  }
  copy.close();
  await rename(temp, target);
  return meta;
}

/** Checks that `file` is a sound Hive backup this version can open, and returns its metadata. */
export function inspectBackup(file: string, schemaVersion: number): BackupMeta {
  let copy: DatabaseSync;
  try {
    copy = new DatabaseSync(file, { readOnly: true });
  } catch (error) {
    throw new HiveError('VALIDATION', `Não foi possível abrir o backup: ${errorMessage(error)}`);
  }
  try {
    const check = copy.prepare('PRAGMA quick_check').get() as { quick_check: string } | undefined;
    if (check?.quick_check !== 'ok')
      throw new HiveError('VALIDATION', 'O arquivo de backup está danificado.');
    const table = copy
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(META);
    if (!table) throw new HiveError('VALIDATION', 'Este arquivo não é um backup do Hive.');
    const row = copy.prepare(`SELECT value FROM ${META} WHERE key = 'meta'`).get() as
      { value: string } | undefined;
    if (!row) throw new HiveError('VALIDATION', 'Este arquivo não é um backup do Hive.');
    const meta = JSON.parse(row.value) as BackupMeta;
    if (meta.schemaVersion > schemaVersion)
      throw new HiveError(
        'VALIDATION',
        `Este backup veio de uma versão mais nova do Hive (${meta.appVersion}). Atualize o Hive antes de restaurar.`,
      );
    return meta;
  } catch (error) {
    if (error instanceof HiveError) throw error;
    throw new HiveError('VALIDATION', `Backup inválido: ${errorMessage(error)}`);
  } finally {
    copy.close();
  }
}

/** Copies a checked backup next to the database; it replaces it at the next start. */
export async function stageRestore(
  dataDir: string,
  file: string,
  schemaVersion: number,
): Promise<BackupMeta> {
  const meta = inspectBackup(file, schemaVersion);
  const pending = path.join(dataDir, PENDING);
  await writeFile(pending, await readFile(file));
  return meta;
}

export async function cancelRestore(dataDir: string): Promise<void> {
  await rm(path.join(dataDir, PENDING), { force: true });
}

/**
 * Runs at startup, before the database opens. If a restore is staged: keeps a copy of the
 * current data, puts the skills from the backup in place and swaps the database file.
 * Returns whether a restore happened. On failure the current data stays and the staged copy
 * is dropped, so a bad backup never blocks the next start.
 */
export async function applyPendingRestore(
  dataDir: string,
  safetyCopy: (target: string) => Promise<void>,
): Promise<boolean> {
  const pending = path.join(dataDir, PENDING);
  if (!existsSync(pending)) return false;
  try {
    if (existsSync(path.join(dataDir, DB_FILE)))
      await safetyCopy(path.join(backupsDir(dataDir), backupName('pre-restore')));
    const skills = skillsDir(dataDir);
    const copy = new DatabaseSync(pending);
    try {
      const rows = copy.prepare(`SELECT path, content FROM ${FILES}`).all() as {
        path: string;
        content: Uint8Array;
      }[];
      await rm(skills, { recursive: true, force: true });
      for (const row of rows) {
        const target = path.resolve(skills, row.path);
        // A crafted backup must not write outside the skills folder.
        if (!target.startsWith(path.resolve(skills) + path.sep)) continue;
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, row.content);
      }
      copy.exec(`DROP TABLE ${FILES}; DROP TABLE ${META};`);
    } finally {
      copy.close();
    }
    for (const suffix of ['', '-wal', '-shm'])
      await rm(path.join(dataDir, DB_FILE + suffix), { force: true });
    await rename(pending, path.join(dataDir, DB_FILE));
    await prune(backupsDir(dataDir), 'pre-restore', KEEP_PRE_RESTORE);
    return true;
  } catch (error) {
    await rm(pending, { force: true });
    throw error;
  }
}

export async function listBackups(dir: string): Promise<BackupInfo[]> {
  if (!existsSync(dir)) return [];
  const items: BackupInfo[] = [];
  for (const name of await readdir(dir)) {
    const match = /^(auto|manual|pre-restore)-.+\.hive-backup$/.exec(name);
    if (!match) continue;
    const info = await stat(path.join(dir, name)).catch(() => null);
    if (!info?.isFile()) continue;
    items.push({
      name,
      kind: match[1] as BackupInfo['kind'],
      createdAt: info.mtime.toISOString(),
      size: info.size,
    });
  }
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Keeps the newest `keep` backups of a kind and deletes the rest. */
export async function prune(dir: string, kind: BackupInfo['kind'], keep: number): Promise<void> {
  const old = (await listBackups(dir)).filter((item) => item.kind === kind).slice(keep);
  for (const item of old) await rm(path.join(dir, item.name), { force: true });
}

/** A name from the renderer must be a plain backup file in the backups folder. */
export function resolveBackup(dir: string, name: string): string {
  if (path.basename(name) !== name || !name.endsWith(`.${BACKUP_EXTENSION}`))
    throw new HiveError('VALIDATION', 'Nome de backup inválido.');
  const file = path.join(dir, name);
  if (!existsSync(file)) throw new HiveError('NOT_FOUND', 'Backup não encontrado.');
  return file;
}

/** Whether the newest automatic backup is older than a day (or missing). */
export async function autoBackupDue(dir: string, now = Date.now()): Promise<boolean> {
  const newest = (await listBackups(dir)).find((item) => item.kind === 'auto');
  return !newest || now - Date.parse(newest.createdAt) >= 24 * 60 * 60 * 1000;
}
