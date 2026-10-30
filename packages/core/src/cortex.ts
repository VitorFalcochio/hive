import { z } from 'zod';
import { workerRoleSchema } from './domain';

/**
 * Cortex: shared, persistent memory for the agents connected to it on the Nexus. A Cortex
 * belongs to one project (workspace); its memories never cross to another project. What an agent
 * may do with it comes only from its connection: no connection, no access.
 *
 * Memories are data written by agents and approved by the user. They are never instructions:
 * every place that shows them to a model frames them as untrusted reference material.
 */

const id = z.string().min(1).max(100);
const text = (max: number) => z.string().trim().max(max);

export const cortexPermissionSchema = z.enum(['read', 'propose', 'approve', 'manage']);
export type CortexPermission = z.infer<typeof cortexPermissionSchema>;

export const cortexPermissionsSchema = z
  .object({
    /** Consult approved memories (and receive them as task context). */
    read: z.boolean(),
    /** Propose new memories, or changes to the ones it wrote. */
    propose: z.boolean(),
    /** Review proposals: a recommendation while human approval is required, a decision otherwise. */
    approve: z.boolean(),
    /** Propose changes to, or revocation of, any memory of this Cortex. */
    manage: z.boolean(),
  })
  .strict();
export type CortexPermissions = z.infer<typeof cortexPermissionsSchema>;

export const defaultCortexPermissions: CortexPermissions = {
  read: true,
  propose: true,
  approve: false,
  manage: false,
};

export const cortexConnectionSchema = z
  .object({
    workerId: id,
    permissions: cortexPermissionsSchema,
    connectedAt: z.string(),
    /** Who made the connection: the user on the canvas, or an Autopilot flow they applied. */
    source: z.enum(['user', 'autopilot']),
  })
  .strict();
export type CortexConnection = z.infer<typeof cortexConnectionSchema>;

export const cortexEmbeddingConfigSchema = z
  .object({
    /** `local`: Hive's built-in embedder, offline and free. `provider`: an OpenAI-compatible `/embeddings`. */
    mode: z.enum(['local', 'provider']),
    providerId: id.nullable(),
    modelId: z.string().min(1).max(200).nullable(),
  })
  .strict();
export type CortexEmbeddingConfig = z.infer<typeof cortexEmbeddingConfigSchema>;

export const cortexConfigSchema = z
  .object({
    /** Only `project` exists today; the field keeps room for other scopes. */
    scope: z.literal('project'),
    persistent: z.literal(true),
    semanticSearch: z.boolean(),
    architecturalDecisions: z.boolean(),
    changeNotifications: z.boolean(),
    /** Agents only ever propose; `direct` lets agents with Approve publish when no human is required. */
    writePolicy: z.enum(['approval', 'direct']),
    humanApprovalRequired: z.boolean(),
    relevanceFiltering: z.boolean(),
    deduplication: z.boolean(),
    /** Most tokens of memory placed in one task's prompt. */
    taskTokenBudget: z.number().int().min(100).max(8_000),
    /** Most tokens one `cortex_search` call returns to an agent. */
    queryTokenBudget: z.number().int().min(100).max(4_000),
    maxResults: z.number().int().min(1).max(20),
    embedding: cortexEmbeddingConfigSchema,
  })
  .strict();
export type CortexConfig = z.infer<typeof cortexConfigSchema>;

export const defaultCortexConfig: CortexConfig = {
  scope: 'project',
  persistent: true,
  semanticSearch: true,
  architecturalDecisions: true,
  changeNotifications: true,
  writePolicy: 'approval',
  humanApprovalRequired: true,
  relevanceFiltering: true,
  deduplication: true,
  taskTokenBudget: 1_200,
  queryTokenBudget: 900,
  maxResults: 6,
  embedding: { mode: 'local', providerId: null, modelId: null },
};

export const cortexNodeSchema = z
  .object({
    id,
    workspaceId: id,
    name: text(60).min(1),
    description: text(300),
    config: cortexConfigSchema,
    connections: z.array(cortexConnectionSchema).max(40),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type CortexNode = z.infer<typeof cortexNodeSchema>;

export const cortexMemoryKindSchema = z.enum([
  'decision',
  'convention',
  'api_contract',
  'requirement',
  'fact',
  'discovery',
]);
export type CortexMemoryKind = z.infer<typeof cortexMemoryKindSchema>;

export const cortexMemoryKindLabels: Record<CortexMemoryKind, string> = {
  decision: 'Decisão',
  convention: 'Convenção',
  api_contract: 'Contrato de API',
  requirement: 'Requisito',
  fact: 'Fato do projeto',
  discovery: 'Descoberta',
};

/** What an agent (or the user) writes; the same shape for a new memory and for a change. */
export const cortexDraftSchema = z
  .object({
    kind: cortexMemoryKindSchema,
    title: text(160).min(3),
    content: text(4_000).min(3),
    rationale: text(2_000),
    tags: z.array(text(40).min(1)).max(12),
    /** Files or other evidence: relative paths, task keys, links. */
    evidence: z.array(text(300).min(1)).max(12),
    /** Roles this concerns most; used to pick who is told about a change. */
    audience: z.array(workerRoleSchema.exclude(['queen'])).max(6),
  })
  .strict();
export type CortexDraft = z.infer<typeof cortexDraftSchema>;

export const cortexActorSchema = z
  .object({
    kind: z.enum(['user', 'agent', 'system']),
    workerId: id.nullable(),
    name: z.string().max(80),
  })
  .strict();
export type CortexActor = z.infer<typeof cortexActorSchema>;

export const cortexOriginSchema = z
  .object({ runId: id.nullable(), missionId: id.nullable(), taskId: id.nullable() })
  .strict();
export type CortexOrigin = z.infer<typeof cortexOriginSchema>;

export const cortexMemoryStatusSchema = z.enum(['active', 'superseded', 'revoked']);
export type CortexMemoryStatus = z.infer<typeof cortexMemoryStatusSchema>;

export const cortexMemorySchema = z
  .object({
    id,
    cortexId: id,
    workspaceId: id,
    ...cortexDraftSchema.shape,
    status: cortexMemoryStatusSchema,
    /** The memory this one replaced, and the one that replaced it. */
    supersedes: id.nullable(),
    supersededBy: id.nullable(),
    author: cortexActorSchema,
    approvedBy: cortexActorSchema,
    origin: cortexOriginSchema,
    version: z.number().int().positive(),
    history: z
      .array(
        z
          .object({
            version: z.number().int().positive(),
            at: z.string(),
            actor: cortexActorSchema,
            change: z.enum(['created', 'edited', 'superseded', 'revoked', 'restored']),
            note: z.string().max(500),
            /** The content as it was before this change (absent for `created`). */
            previous: cortexDraftSchema.nullable(),
          })
          .strict(),
      )
      .max(100),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type CortexMemory = z.infer<typeof cortexMemorySchema>;

export const cortexProposalStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'changes_requested',
]);
export type CortexProposalStatus = z.infer<typeof cortexProposalStatusSchema>;

export const cortexProposalSchema = z
  .object({
    id,
    cortexId: id,
    workspaceId: id,
    action: z.enum(['create', 'update', 'revoke']),
    /** The memory changed or revoked; for `create`, a memory it would supersede. */
    targetMemoryId: id.nullable(),
    draft: cortexDraftSchema,
    proposer: cortexActorSchema,
    origin: cortexOriginSchema,
    status: cortexProposalStatusSchema,
    /** Active memories that look like the same knowledge, best first. */
    duplicates: z.array(z.object({ memoryId: id, score: z.number() }).strict()).max(5),
    /** Opinions recorded before the decision: agents with Approve and the Queen. */
    reviews: z
      .array(
        z
          .object({
            actor: cortexActorSchema,
            verdict: z.enum(['approve', 'reject', 'merge', 'revise']),
            reason: z.string().max(1_000),
            at: z.string(),
          })
          .strict(),
      )
      .max(10),
    resolution: z
      .object({
        actor: cortexActorSchema,
        note: z.string().max(1_000),
        at: z.string(),
        memoryId: id.nullable(),
      })
      .strict()
      .nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type CortexProposal = z.infer<typeof cortexProposalSchema>;

export const cortexActivityTypeSchema = z.enum([
  'created',
  'configured',
  'connected',
  'disconnected',
  'permissions',
  'query',
  'context',
  'proposed',
  'reviewed',
  'approved',
  'rejected',
  'changes_requested',
  'edited',
  'revoked',
  'notified',
  'delivered',
  'denied',
  'embedding',
]);
export type CortexActivityType = z.infer<typeof cortexActivityTypeSchema>;

export interface CortexActivity {
  seq: number;
  id: string;
  cortexId: string;
  workspaceId: string;
  ts: string;
  type: CortexActivityType;
  actor: CortexActor;
  runId: string | null;
  taskId: string | null;
  message: string;
  /** Memories involved (results returned, the one approved…). */
  memoryIds: string[];
  data: Record<string, unknown> | null;
}

export const cortexNotificationSchema = z
  .object({
    id,
    cortexId: id,
    workspaceId: id,
    workerId: id,
    memoryId: id,
    change: z.enum(['approved', 'updated', 'superseded', 'revoked']),
    reason: z.string().max(300),
    createdAt: z.string(),
    /** Set at the safe point it was handed over: the start of the agent's next task. */
    deliveredAt: z.string().nullable(),
    deliveredTaskId: id.nullable(),
  })
  .strict();
export type CortexNotification = z.infer<typeof cortexNotificationSchema>;

/** What the Nexus block shows. */
export interface CortexOverview {
  node: CortexNode;
  memories: { active: number; superseded: number; revoked: number };
  decisions: number;
  pendingApprovals: number;
  pendingNotifications: number;
  lastActivityAt: string | null;
  /** The engine the next search uses, and whether the last provider call failed. */
  embedding: { model: string; degraded: string | null };
}

export interface CortexSearchHit {
  memory: CortexMemory;
  score: number;
  similarity: number;
}

export interface CortexSearchResult {
  hits: CortexSearchHit[];
  model: string;
  /** Set when the configured provider failed and the local engine answered instead. */
  degraded: string | null;
  tokens: number;
}

/* ---------------------------------------------------------------- IPC inputs */

export const cortexCreateSchema = z
  .object({
    runId: id,
    name: text(60).min(1).optional(),
  })
  .strict();

export const cortexUpdateSchema = z
  .object({
    cortexId: id,
    name: text(60).min(1).optional(),
    description: text(300).optional(),
    config: cortexConfigSchema.partial().optional(),
  })
  .strict();

export const cortexConnectSchema = z
  .object({
    cortexId: id,
    workerId: id,
    permissions: cortexPermissionsSchema.optional(),
  })
  .strict();

export const cortexMemoryQuerySchema = z
  .object({
    cortexId: id,
    status: z.array(cortexMemoryStatusSchema).max(3).optional(),
    kinds: z.array(cortexMemoryKindSchema).max(6).optional(),
    search: z.string().trim().max(300).optional(),
    limit: z.number().int().min(1).max(500).default(200),
  })
  .strict();

export const cortexResolveSchema = z
  .object({
    proposalId: id,
    decision: z.enum(['approve', 'reject', 'request_changes']),
    note: z.string().trim().max(1_000).default(''),
    /** The user may correct the draft before approving it. */
    draft: cortexDraftSchema.optional(),
  })
  .strict();

export const cortexEditSchema = z
  .object({
    memoryId: id,
    expectedVersion: z.number().int().positive(),
    draft: cortexDraftSchema,
    note: z.string().trim().max(500).default(''),
  })
  .strict();

export const cortexRevokeSchema = z
  .object({
    memoryId: id,
    expectedVersion: z.number().int().positive(),
    note: z.string().trim().min(1).max(500),
  })
  .strict();

export const cortexActivityQuerySchema = z
  .object({
    cortexId: id,
    types: z.array(cortexActivityTypeSchema).max(20).optional(),
    limit: z.number().int().min(1).max(500).default(200),
  })
  .strict();

/** Rough token count for budgets: about four characters per token for mixed pt/en text. */
export const estimateTokens = (value: string): number => Math.ceil(value.length / 4);
