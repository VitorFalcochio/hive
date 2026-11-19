import type { HiveDatabase } from '@hive/persistence';
import { clipText } from '@hive/shared';

/**
 * Records big enough to freeze the app when loaded. Before the limits on error texts existed,
 * one failed `git diff` stored a 67 MB message in a task, its run report, its log and its live
 * result; every screen that read them hung. Hive looks for such records at startup and offers
 * to shrink them, after a backup, instead of hanging without saying why.
 */
export const OVERSIZED_BYTES = 1024 * 1024;
/** A shrunk string keeps this much, start and end, with the cut stated in the text. */
const KEEP = 8_000;

export interface OversizedRecord {
  table: 'tasks' | 'runs' | 'events' | 'live_results';
  id: string;
  bytes: number;
}

export function findOversized(database: HiveDatabase): OversizedRecord[] {
  const db = database.db;
  const query = (sql: string, table: OversizedRecord['table']) =>
    (db.prepare(sql).all(OVERSIZED_BYTES) as { id: string | number; bytes: number }[]).map(
      (row) => ({ table, id: String(row.id), bytes: Number(row.bytes) }),
    );
  return [
    ...query('SELECT id, LENGTH(data) AS bytes FROM tasks WHERE LENGTH(data) > ?', 'tasks'),
    ...query('SELECT id, LENGTH(data) AS bytes FROM runs WHERE LENGTH(data) > ?', 'runs'),
    ...query(
      'SELECT seq AS id, LENGTH(message) + IFNULL(LENGTH(data), 0) AS bytes FROM events WHERE LENGTH(message) + IFNULL(LENGTH(data), 0) > ?',
      'events',
    ),
    ...query(
      'SELECT run_id AS id, LENGTH(data) AS bytes FROM live_results WHERE LENGTH(data) > ?',
      'live_results',
    ),
  ];
}

/** Every string longer than the limit, at any depth, cut down with the cut stated. */
export function shrinkStrings(value: unknown, max = KEEP): unknown {
  if (typeof value === 'string') return value.length > max ? clipText(value, max) : value;
  if (Array.isArray(value)) return value.map((item) => shrinkStrings(item, max));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, shrinkStrings(item, max)]),
    );
  return value;
}

/**
 * Shrinks the records `findOversized` found. Nothing is deleted except live results, a
 * projection Hive rebuilds from the log on its own. Call only after a backup.
 */
export function repairOversized(database: HiveDatabase, records: OversizedRecord[]): void {
  const db = database.db;
  const rewrite = (table: 'tasks' | 'runs', id: string) => {
    const row = db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as
      { data: string } | undefined;
    if (!row) return;
    const data = JSON.stringify(shrinkStrings(JSON.parse(row.data)));
    db.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`).run(data, id);
  };
  db.exec('BEGIN');
  try {
    for (const record of records) {
      if (record.table === 'tasks' || record.table === 'runs') rewrite(record.table, record.id);
      else if (record.table === 'live_results')
        db.prepare('DELETE FROM live_results WHERE run_id = ?').run(record.id);
      else {
        const row = db
          .prepare('SELECT message, data FROM events WHERE seq = ?')
          .get(Number(record.id)) as { message: string; data: string | null } | undefined;
        if (!row) continue;
        db.prepare('UPDATE events SET message = ?, data = ? WHERE seq = ?').run(
          clipText(row.message, KEEP),
          row.data === null ? null : JSON.stringify(shrinkStrings(JSON.parse(row.data))),
          Number(record.id),
        );
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  // Gives the freed space back to the file system's view of the log right away.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

export function describeOversized(records: OversizedRecord[]): string {
  const names: Record<OversizedRecord['table'], string> = {
    tasks: 'tarefa',
    runs: 'execução',
    events: 'registro do log',
    live_results: 'resultado vivo',
  };
  const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  const total = records.reduce((sum, record) => sum + record.bytes, 0);
  return [
    `${records.length} registro(s) somam ${mb(total)}:`,
    ...records
      .slice(0, 8)
      .map((record) => `• ${names[record.table]} ${record.id}: ${mb(record.bytes)}`),
    ...(records.length > 8 ? [`• e mais ${records.length - 8}`] : []),
  ].join('\n');
}
