import {
  agentEventSchema,
  approvalSchema,
  chatTurnSchema,
  defaultSettings,
  missionSchema,
  modelInfoSchema,
  nexusAutopilotPlanSchema,
  providerConfigSchema,
  runSchema,
  settingsSchema,
  taskSchema,
  workerSchema,
  workspaceSchema,
  type AgentEvent,
  type Approval,
  type ChatTurn,
  type EventQuery,
  type Mission,
  type ModelInfo,
  type ProviderConfig,
  type Run,
  type Settings,
  type Task,
  type Worker,
  type Workspace,
  type LiveResult,
  type MissionNote,
  type NexusAutopilotPlan,
  type ResultEventPage,
} from '@hive/core';
import type { SQLInputValue } from 'node:sqlite';
import { HiveError } from '@hive/shared';
import type { HiveDatabase } from './database';
import { CortexRepository } from './cortex';
import { JsonTable, type Row } from './json-table';

export class Repositories {
  readonly workspaces: JsonTable<Workspace>;
  readonly providers: JsonTable<ProviderConfig>;
  readonly workers: JsonTable<Worker>;
  readonly missions: JsonTable<Mission>;
  readonly runs: JsonTable<Run>;
  readonly tasks: JsonTable<Task>;
  readonly approvals: JsonTable<Approval>;
  readonly chatTurns: JsonTable<ChatTurn>;
  readonly nexusAutopilotPlans: JsonTable<NexusAutopilotPlan>;
  readonly cortex: CortexRepository;

  constructor(private readonly db: HiveDatabase) {
    this.cortex = new CortexRepository(db);
    this.workspaces = new JsonTable(db, 'workspaces', workspaceSchema, (w) => ({ path: w.path }));
    this.providers = new JsonTable(db, 'providers', providerConfigSchema);
    this.workers = new JsonTable(db, 'workers', workerSchema);
    this.missions = new JsonTable(db, 'missions', missionSchema, (m) => ({
      workspace_id: m.workspaceId,
    }));
    this.runs = new JsonTable(db, 'runs', runSchema, (r) => ({
      mission_id: r.missionId,
      workspace_id: r.workspaceId,
    }));
    this.tasks = new JsonTable(db, 'tasks', taskSchema, (t) => ({
      run_id: t.runId,
      worker_id: t.workerId,
    }));
    this.approvals = new JsonTable(db, 'approvals', approvalSchema, (a) => ({
      run_id: a.runId,
      task_id: a.taskId,
      status: a.status,
    }));
    this.chatTurns = new JsonTable(db, 'chat_turns', chatTurnSchema, (c) => ({
      workspace_id: c.workspaceId,
    }));
    this.nexusAutopilotPlans = new JsonTable(
      db,
      'nexus_autopilot_plans',
      nexusAutopilotPlanSchema,
      (plan) => ({ run_id: plan.runId, version: plan.version, state: plan.state }),
    );
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
    return (
      this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value ?? null
    );
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
    const row = this.db.get<{ ciphertext: Uint8Array; hint: string }>(
      'SELECT ciphertext, hint FROM secrets WHERE id = ?',
      id,
    );
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
    const row = this.db.get<Row>(
      'SELECT data FROM models WHERE provider_id = ? AND id = ?',
      providerId,
      modelId,
    );
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
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
    if (query.runId) {
      where.push('run_id = ?');
      params.push(query.runId);
    }
    if (query.taskId) {
      where.push('task_id = ?');
      params.push(query.taskId);
    }
    if (query.workerId) {
      where.push('worker_id = ?');
      params.push(query.workerId);
    }
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

  /** Stable database sequence, independent of timestamps and delivery order. */
  resultEvents(
    runId: string,
    options: { after?: number; before?: number; limit?: number } = {},
  ): ResultEventPage {
    this.runs.require(runId, 'Execução');
    const limit = options.limit ?? 500;
    const forward = options.after !== undefined;
    const rows = this.db.all<{
      seq: number;
      id: string;
      ts: string;
      workspace_id: string | null;
      run_id: string;
      task_id: string | null;
      worker_id: string | null;
      type: string;
      level: string;
      message: string;
      data: string | null;
    }>(
      `SELECT * FROM events WHERE run_id = ? AND seq ${forward ? '>' : '<'} ? ORDER BY seq ${forward ? 'ASC' : 'DESC'} LIMIT ?`,
      runId,
      forward ? options.after! : (options.before ?? Number.MAX_SAFE_INTEGER),
      limit + 1,
    );
    const selected = rows.slice(0, limit);
    return {
      hasMore: rows.length > limit,
      events: (forward ? selected : selected.reverse()).map((row) => ({
        cursor: row.seq,
        event: agentEventSchema.parse({
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
      })),
    };
  }

  getLiveResult(runId: string): LiveResult | null {
    const row = this.db.get<Row>('SELECT data FROM live_results WHERE run_id = ?', runId);
    return row ? (JSON.parse(row.data) as LiveResult) : null;
  }

  /** This method cannot write mission_notes. Events remain in their original append-only table. */
  saveLiveResult(result: LiveResult): void {
    this.db.transaction(() => {
      const previous = this.getLiveResult(result.runId);
      this.db.run(
        'INSERT INTO live_results (run_id, data) VALUES (?, ?) ON CONFLICT(run_id) DO UPDATE SET data = excluded.data',
        result.runId,
        JSON.stringify(result),
      );
      if (previous?.summary !== result.summary)
        this.db.run(
          'INSERT INTO generated_summaries (run_id, cursor, text, created_at) VALUES (?, ?, ?, ?)',
          result.runId,
          result.cursor,
          result.summary,
          result.updatedAt ?? new Date().toISOString(),
        );
    });
  }

  getMissionNote(missionId: string): MissionNote {
    this.missions.require(missionId, 'Missão');
    const row = this.db.get<{ text: string; revision: number; updated_at: string }>(
      'SELECT text, revision, updated_at FROM mission_notes WHERE mission_id = ?',
      missionId,
    );
    return {
      missionId,
      text: row?.text ?? '',
      revision: row?.revision ?? 0,
      updatedAt: row?.updated_at ?? null,
    };
  }

  /** Compare-and-swap prevents stale windows from replacing newer manual edits. */
  saveMissionNote(missionId: string, text: string, revision: number): MissionNote {
    return this.db.transaction(() => {
      const current = this.getMissionNote(missionId);
      if (current.revision !== revision)
        throw new HiveError(
          'CONFLICT',
          'As notas foram alteradas em outra janela. Seu rascunho foi preservado; revise a versão salva antes de substituir.',
        );
      const updatedAt = new Date().toISOString();
      this.db.run(
        'INSERT INTO mission_notes (mission_id, text, revision, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(mission_id) DO UPDATE SET text = excluded.text, revision = excluded.revision, updated_at = excluded.updated_at',
        missionId,
        text,
        revision + 1,
        updatedAt,
      );
      return { missionId, text, revision: revision + 1, updatedAt };
    });
  }

  /** Tokens of the tasks, in every project, that finished at or after `since` (an ISO time). */
  usageSince(since: string): { promptTokens: number; completionTokens: number } {
    let promptTokens = 0;
    let completionTokens = 0;
    for (const task of this.tasks.list('updated_at >= ?', since)) {
      if (!task.finishedAt || task.finishedAt < since) continue;
      promptTokens += task.result?.usage.promptTokens ?? 0;
      completionTokens += task.result?.usage.completionTokens ?? 0;
    }
    // Conversations with agents in the terminal spend tokens too.
    for (const turn of this.chatTurns.list('updated_at >= ?', since)) {
      if (turn.finishedAt < since) continue;
      promptTokens += turn.promptTokens;
      completionTokens += turn.completionTokens;
    }
    return { promptTokens, completionTokens };
  }

  usageTotals(workspaceId: string | null): {
    promptTokens: number;
    completionTokens: number;
    runsCounted: number;
  } {
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
