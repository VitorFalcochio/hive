import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

/**
 * Ordered schema migrations. Never edit a published migration; append a new one.
 * Entities are stored as validated JSON in `data`, with the columns needed for lookups and
 * ordering duplicated alongside. Events are fully columnar because they are filtered heavily.
 */
const migrations: string[] = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE providers (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE secrets (id TEXT PRIMARY KEY, ciphertext BLOB NOT NULL, hint TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE models (provider_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (provider_id, id));
  CREATE TABLE workers (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE missions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX missions_workspace ON missions(workspace_id, updated_at);
  CREATE TABLE runs (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, workspace_id TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX runs_mission ON runs(mission_id, updated_at);
  CREATE INDEX runs_workspace ON runs(workspace_id, updated_at);
  CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, worker_id TEXT, updated_at TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX tasks_run ON tasks(run_id);
  CREATE INDEX tasks_worker ON tasks(worker_id, updated_at);
  CREATE TABLE approvals (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX approvals_status ON approvals(status);
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    ts TEXT NOT NULL,
    workspace_id TEXT,
    run_id TEXT,
    task_id TEXT,
    worker_id TEXT,
    type TEXT NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    data TEXT
  );
  CREATE INDEX events_run ON events(run_id, seq);
  CREATE INDEX events_task ON events(task_id, seq);
  CREATE INDEX events_worker ON events(worker_id, seq);
  `,
];

export class HiveDatabase {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  get schemaVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    return row.user_version;
  }

  private migrate(): void {
    const current = this.schemaVersion;
    for (let index = current; index < migrations.length; index++) {
      this.transaction(() => {
        this.db.exec(migrations[index]!);
        this.db.exec(`PRAGMA user_version = ${index + 1}`);
      });
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: SQLInputValue[]): void {
    this.db.prepare(sql).run(...params);
  }

  close(): void {
    this.db.close();
  }
}
