import {
  agentEventSchema,
  approvalSchema,
  defaultSettings,
  missionSchema,
  modelInfoSchema,
  providerConfigSchema,
  runSchema,
  settingsSchema,
  taskSchema,
  workerSchema,
  workspaceSchema,
  type AgentEvent,
  type Approval,
  type EventQuery,
  type Mission,
  type ModelInfo,
  type ProviderConfig,
  type Run,
  type Settings,
  type Task,
  type Worker,
  type Workspace,
} from '@hive/core';
import type { SQLInputValue } from 'node:sqlite';
import type { z } from 'zod';
import type { HiveDatabase } from './database';

interface Row {
  data: string;
}

/**
 * A table whose rows hold one validated JSON entity plus lookup columns. Reads are validated
 * again, so a corrupted or hand-edited database fails loudly instead of leaking bad state.
 */
class JsonTable<T extends { id: string }> {
  constructor(
    private readonly db: HiveDatabase,
    private readonly table: string,
    private readonly schema: z.ZodType<T>,
    private readonly columns: (entity: T) => Record<string, SQLInputValue> = () => ({}),
  ) {}

  get(id: string): T | null {
    const row = this.db.get<Row>(`SELECT data FROM ${this.table} WHERE id = ?`, id);
    return row ? this.parse(row) : null;
  }

  require(id: string, what: string): T {
    const found = this.get(id);
    if (!found) throw Object.assign(new Error(`${what} not found: ${id}`), { code: 'NOT_FOUND' });
    return found;
  }

  list(where = '', ...params: SQLInputValue[]): T[] {
    const sql = `SELECT data FROM ${this.table} ${where ? `WHERE ${where}` : ''} ORDER BY updated_at DESC`;
    return this.db.all<Row>(sql, ...params).map((row) => this.parse(row));
  }

  put(entity: T): T {
    const valid = this.schema.parse(entity);
    const extra = this.columns(valid);
    const names = ['id', ...Object.keys(extra), 'updated_at', 'data'];
    const values: SQLInputValue[] = [valid.id, ...Object.values(extra), new Date().toISOString(), JSON.stringify(valid)];
    const updates = names.filter((name) => name !== 'id').map((name) => `${name} = excluded.${name}`);
    this.db.run(
      `INSERT INTO ${this.table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})
       ON CONFLICT(id) DO UPDATE SET ${updates.join(', ')}`,
      ...values,
    );
    return valid;
  }

  delete(id: string): void {
    this.db.run(`DELETE FROM ${this.table} WHERE id = ?`, id);
  }

  private parse(row: Row): T {
    return this.schema.parse(JSON.parse(row.data));
  }
}

export class Repositories {
  readonly workspaces: JsonTable<Workspace>;
  readonly providers: JsonTable<ProviderConfig>;
  readonly workers: JsonTable<Worker>;
  readonly missions: JsonTable<Mission>;
  readonly runs: JsonTable<Run>;
  readonly tasks: JsonTable<Task>;
  readonly approvals: JsonTable<Approval>;

  constructor(private readonly db: HiveDatabase) {
    this.workspaces = new JsonTable(db, 'workspaces', workspaceSchema, (w) => ({ path: w.path }));
    this.providers = new JsonTable(db, 'providers', providerConfigSchema);
    this.workers = new JsonTable(db, 'workers', workerSchema);
    this.missions = new JsonTable(db, 'missions', missionSchema, (m) => ({ workspace_id: m.workspaceId }));
    this.runs = new JsonTable(db, 'runs', runSchema, (r) => ({ mission_id: r.missionId, workspace_id: r.workspaceId }));
    this.tasks = new JsonTable(db, 'tasks', taskSchema, (t) => ({ run_id: t.runId, worker_id: t.workerId }));
    this.approvals = new JsonTable(db, 'approvals', approvalSchema, (a) => ({
      run_id: a.runId,
      task_id: a.taskId,
      status: a.status,
    }));
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  /* ------------------------------------------------------------ settings */

  getSettings(): Settings {
    const row = this.db.get<{ value: string }>(`SELECT value FROM settings WHERE key = 'app'`);
    if (!row) return defaultSettings;
    const parsed = settingsSchema.safeParse({ ...defaultSettings, ...JSON.parse(row.value) });
    return parsed.success ? parsed.data : defaultSettings;
  }

  saveSettings(settings: Settings): Settings {
    const valid = settingsSchema.parse(settings);
    this.db.run(
      `INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      JSON.stringify(valid),
    );
    return valid;
  }

  getValue(key: string): string | null {
    return this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value ?? null;
  }

  setValue(key: string, value: string | null): void {
    if (value === null) this.db.run('DELETE FROM settings WHERE key = ?', key);
    else
      this.db.run(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        key,
        value,
      );
  }

  /* ------------------------------------------------------------ secrets (ciphertext only) */

  getSecret(id: string): { ciphertext: Uint8Array; hint: string } | null {
    const row = this.db.get<{ ciphertext: Uint8Array; hint: string }>('SELECT ciphertext, hint FROM secrets WHERE id = ?', id);
    return row ?? null;
  }

  putSecret(id: string, ciphertext: Uint8Array, hint: string): void {
    this.db.run(
      `INSERT INTO secrets (id, ciphertext, hint, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET ciphertext = excluded.ciphertext, hint = excluded.hint, updated_at = excluded.updated_at`,
      id,
      ciphertext,
      hint,
      new Date().toISOString(),
    );
  }

  deleteSecret(id: string): void {
    this.db.run('DELETE FROM secrets WHERE id = ?', id);
  }

  /* ------------------------------------------------------------ model catalog cache */

  listModels(providerId: string): ModelInfo[] {
    return this.db
      .all<Row>('SELECT data FROM models WHERE provider_id = ? ORDER BY id', providerId)
      .map((row) => modelInfoSchema.parse(JSON.parse(row.data)));
  }

  getModel(providerId: string, modelId: string): ModelInfo | null {
    const row = this.db.get<Row>('SELECT data FROM models WHERE provider_id = ? AND id = ?', providerId, modelId);
    return row ? modelInfoSchema.parse(JSON.parse(row.data)) : null;
  }

  replaceModels(providerId: string, models: ModelInfo[]): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM models WHERE provider_id = ?', providerId);
      for (const model of models) this.putModel(model);
    });
  }

  putModel(model: ModelInfo): void {
    const valid = modelInfoSchema.parse(model);
    this.db.run(
      `INSERT INTO models (provider_id, id, data) VALUES (?, ?, ?)
       ON CONFLICT(provider_id, id) DO UPDATE SET data = excluded.data`,
      valid.providerId,
      valid.id,
      JSON.stringify(valid),
    );
  }

  deleteModels(providerId: string): void {
    this.db.run('DELETE FROM models WHERE provider_id = ?', providerId);
  }

  /* ------------------------------------------------------------ events */

  appendEvent(event: AgentEvent): void {
    const valid = agentEventSchema.parse(event);
    this.db.run(
      `INSERT INTO events (id, ts, workspace_id, run_id, task_id, worker_id, type, level, message, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      valid.id,
      valid.ts,
      valid.workspaceId,
      valid.runId,
      valid.taskId,
      valid.workerId,
      valid.type,
      valid.level,
      valid.message,
      valid.data ? JSON.stringify(valid.data) : null,
    );
  }

  queryEvents(query: EventQuery): AgentEvent[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (query.runId) (where.push('run_id = ?'), params.push(query.runId));
    if (query.taskId) (where.push('task_id = ?'), params.push(query.taskId));
    if (query.workerId) (where.push('worker_id = ?'), params.push(query.workerId));
    if (query.types?.length) {
      where.push(`type IN (${query.types.map(() => '?').join(', ')})`);
      params.push(...query.types);
    }
    if (query.levels?.length) {
      where.push(`level IN (${query.levels.map(() => '?').join(', ')})`);
      params.push(...query.levels);
    }
    if (query.search) {
      where.push(`message LIKE ? ESCAPE '\\'`);
      params.push(`%${query.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    if (query.before) {
      where.push('seq < (SELECT seq FROM events WHERE id = ?)');
      params.push(query.before);
    }
    const limit = query.limit ?? 500;
    const rows = this.db.all<{
      id: string;
      ts: string;
      workspace_id: string | null;
      run_id: string | null;
      task_id: string | null;
      worker_id: string | null;
      type: string;
      level: string;
      message: string;
      data: string | null;
    }>(
      `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`,
      ...params,
      limit,
    );
    return rows.reverse().map((row) =>
      agentEventSchema.parse({
        id: row.id,
        ts: row.ts,
        workspaceId: row.workspace_id,
        runId: row.run_id,
        taskId: row.task_id,
        workerId: row.worker_id,
        type: row.type,
        level: row.level,
        message: row.message,
        data: row.data ? JSON.parse(row.data) : null,
      }),
    );
  }

  usageTotals(workspaceId: string | null): { promptTokens: number; completionTokens: number; runsCounted: number } {
    const runs = workspaceId ? this.runs.list('workspace_id = ?', workspaceId) : this.runs.list();
    let promptTokens = 0;
    let completionTokens = 0;
    for (const run of runs) {
      for (const task of this.tasks.list('run_id = ?', run.id)) {
        promptTokens += task.result?.usage.promptTokens ?? 0;
        completionTokens += task.result?.usage.completionTokens ?? 0;
      }
    }
    return { promptTokens, completionTokens, runsCounted: runs.length };
  }
}
