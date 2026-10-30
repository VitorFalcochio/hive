import {
  cortexActivityTypeSchema,
  cortexActorSchema,
  cortexMemorySchema,
  cortexNodeSchema,
  cortexNotificationSchema,
  cortexProposalSchema,
  type CortexActivity,
  type CortexActivityType,
  type CortexMemory,
  type CortexNode,
  type CortexNotification,
  type CortexProposal,
} from '@hive/core';
import { newId, nowIso } from '@hive/shared';
import type { SQLInputValue } from 'node:sqlite';
import type { HiveDatabase } from './database';
import { JsonTable } from './json-table';

export type NewCortexActivity = Omit<CortexActivity, 'seq' | 'id' | 'ts'> & { ts?: string };

interface ActivityRow {
  seq: number;
  id: string;
  cortex_id: string;
  workspace_id: string;
  ts: string;
  type: string;
  data: string;
}

/**
 * Storage of the Cortex: blocks, memories, proposals, change notices, the activity log and the
 * vector index. Every read is validated again; vectors are stored per embedding model, so a
 * change of model never compares vectors of different spaces.
 */
export class CortexRepository {
  readonly nodes: JsonTable<CortexNode>;
  readonly memories: JsonTable<CortexMemory>;
  readonly proposals: JsonTable<CortexProposal>;
  readonly notifications: JsonTable<CortexNotification>;

  constructor(private readonly db: HiveDatabase) {
    this.nodes = new JsonTable(db, 'cortex_nodes', cortexNodeSchema, (node) => ({
      workspace_id: node.workspaceId,
    }));
    this.memories = new JsonTable(db, 'cortex_memories', cortexMemorySchema, (memory) => ({
      cortex_id: memory.cortexId,
      workspace_id: memory.workspaceId,
      status: memory.status,
      kind: memory.kind,
    }));
    this.proposals = new JsonTable(db, 'cortex_proposals', cortexProposalSchema, (proposal) => ({
      cortex_id: proposal.cortexId,
      workspace_id: proposal.workspaceId,
      status: proposal.status,
    }));
    this.notifications = new JsonTable(
      db,
      'cortex_notifications',
      cortexNotificationSchema,
      (notice) => ({
        cortex_id: notice.cortexId,
        workspace_id: notice.workspaceId,
        worker_id: notice.workerId,
        delivered: notice.deliveredAt ? 1 : 0,
      }),
    );
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  /* ------------------------------------------------------------ activity */

  log(entry: NewCortexActivity): CortexActivity {
    const activity: CortexActivity = {
      ...entry,
      actor: cortexActorSchema.parse(entry.actor),
      type: cortexActivityTypeSchema.parse(entry.type),
      id: newId('cxa'),
      ts: entry.ts ?? nowIso(),
      seq: 0,
    };
    this.db.run(
      'INSERT INTO cortex_activity (id, cortex_id, workspace_id, ts, type, data) VALUES (?, ?, ?, ?, ?, ?)',
      activity.id,
      activity.cortexId,
      activity.workspaceId,
      activity.ts,
      activity.type,
      JSON.stringify({
        actor: activity.actor,
        runId: activity.runId,
        taskId: activity.taskId,
        message: activity.message.slice(0, 2_000),
        memoryIds: activity.memoryIds.slice(0, 50),
        data: activity.data,
      }),
    );
    const row = this.db.get<{ seq: number }>(
      'SELECT seq FROM cortex_activity WHERE id = ?',
      activity.id,
    );
    return { ...activity, seq: row?.seq ?? 0 };
  }

  activity(
    cortexId: string,
    options: { types?: CortexActivityType[]; limit?: number } = {},
  ): CortexActivity[] {
    const where = ['cortex_id = ?'];
    const params: SQLInputValue[] = [cortexId];
    if (options.types?.length) {
      where.push(`type IN (${options.types.map(() => '?').join(', ')})`);
      params.push(...options.types);
    }
    return this.db
      .all<ActivityRow>(
        `SELECT * FROM cortex_activity WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ?`,
        ...params,
        options.limit ?? 200,
      )
      .map((row) => {
        const data = JSON.parse(row.data) as Omit<
          CortexActivity,
          'seq' | 'id' | 'cortexId' | 'workspaceId' | 'ts' | 'type'
        >;
        return {
          seq: row.seq,
          id: row.id,
          cortexId: row.cortex_id,
          workspaceId: row.workspace_id,
          ts: row.ts,
          type: cortexActivityTypeSchema.parse(row.type),
          ...data,
        };
      });
  }

  /** Memory ids handed to one agent (as context or search results), most recent first. */
  memoriesSeenBy(cortexId: string, workerId: string, limit = 400): Set<string> {
    const seen = new Set<string>();
    for (const entry of this.activity(cortexId, { types: ['context', 'query'], limit }))
      if (entry.actor.workerId === workerId)
        for (const memoryId of entry.memoryIds) seen.add(memoryId);
    return seen;
  }

  /* ------------------------------------------------------------ vectors */

  vector(memoryId: string, model: string): { hash: string; vector: Float32Array } | null {
    const row = this.db.get<{ hash: string; dim: number; vector: Uint8Array }>(
      'SELECT hash, dim, vector FROM cortex_embeddings WHERE memory_id = ? AND model = ?',
      memoryId,
      model,
    );
    if (!row) return null;
    const bytes = new Uint8Array(row.vector);
    if (bytes.byteLength !== row.dim * 4) return null;
    return { hash: row.hash, vector: new Float32Array(bytes.buffer, bytes.byteOffset, row.dim) };
  }

  putVector(memoryId: string, model: string, hash: string, vector: Float32Array): void {
    const bytes = new Uint8Array(
      vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength),
    );
    this.db.run(
      `INSERT INTO cortex_embeddings (memory_id, model, hash, dim, vector, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(memory_id, model) DO UPDATE SET hash = excluded.hash, dim = excluded.dim, vector = excluded.vector, updated_at = excluded.updated_at`,
      memoryId,
      model,
      hash,
      vector.length,
      bytes,
      nowIso(),
    );
  }

  /** Removes a block and, with `purge`, everything it stored. */
  deleteNode(cortexId: string, purge: boolean): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM cortex_nodes WHERE id = ?', cortexId);
      if (!purge) return;
      this.db.run(
        'DELETE FROM cortex_embeddings WHERE memory_id IN (SELECT id FROM cortex_memories WHERE cortex_id = ?)',
        cortexId,
      );
      for (const table of [
        'cortex_memories',
        'cortex_proposals',
        'cortex_notifications',
        'cortex_activity',
      ])
        this.db.run(`DELETE FROM ${table} WHERE cortex_id = ?`, cortexId);
    });
  }
}
