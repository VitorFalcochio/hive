import { z } from 'zod';

/*
 * Hive Teams: a leader agent asks for other agents and gives them work, through Hive. These are
 * the shapes it leaves in the database. Every field added to agents and tasks is optional, so
 * missions and agents saved before Hive Teams read exactly as before.
 */

/**
 * Where an agent created by Hive Teams came from. Its identity (this record) is separate from
 * the work it does (tasks): one agent can take several tasks of its team.
 */
export const workerTeamSchema = z.object({
  /** The mission run the agent belongs to; it is not offered to other missions. */
  runId: z.string(),
  /** The agent it reports to (its leader). */
  parentAgentId: z.string().nullable(),
  /** The agent that asked for it; the same as the parent unless a leader asks on another's behalf. */
  createdByAgentId: z.string().nullable(),
  /** The request that created it, so creating it again returns this same agent. */
  spawnRequestId: z.string().nullable(),
  /** 0 for a leader picked by the Queen, 1 for its members, and so on. */
  depth: z.number().int().min(0).max(4),
});
export type WorkerTeam = z.infer<typeof workerTeamSchema>;

export const teamTaskRoleSchema = z.enum([
  /** The leader's first session: defines the contract and delegates. */
  'lead',
  /** Work a leader gave to one of its members. */
  'member',
  /** A member reviewing other tasks of the team. */
  'review',
  /** The leader's resumed session once its members' work is done. */
  'consolidate',
]);
export type TeamTaskRole = z.infer<typeof teamTaskRoleSchema>;

export const taskTeamSchema = z.object({
  role: teamTaskRoleSchema,
  /** The leader's 'lead' task this one belongs to (itself, for the lead task). */
  leadTaskId: z.string(),
  /** The delegation that created it; null for the lead task. */
  requestId: z.string().nullable(),
  /** Tasks a review task looks at, by id. */
  reviewOf: z.array(z.string()).optional(),
  /** How many times the leader has been resumed so far (consolidate tasks only). */
  resume: z.number().int().min(0).optional(),
});
export type TaskTeam = z.infer<typeof taskTeamSchema>;

export const teamMessageKindSchema = z.enum([
  'spawn',
  'delegation',
  'review_request',
  'feedback',
  'report',
  'note',
]);
export type TeamMessageKind = z.infer<typeof teamMessageKindSchema>;

/**
 * One message between the agents of a mission (or to and from the Queen). Its id comes from its
 * idempotency key, so sending the same message again (after a retry or a crash) stores nothing new.
 */
export const teamMessageSchema = z.object({
  id: z.string(),
  runId: z.string(),
  idempotencyKey: z.string().min(1).max(300),
  kind: teamMessageKindSchema,
  /** Agent ids; null stands for the Queen. */
  fromAgentId: z.string().nullable(),
  toAgentId: z.string().nullable(),
  fromTaskId: z.string().nullable(),
  toTaskId: z.string().nullable(),
  subject: z.string().max(200),
  body: z.string().max(12_000),
  /** Structured content: a review's verdict and comments, a report's figures. */
  payload: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
});
export type TeamMessage = z.infer<typeof teamMessageSchema>;

export const teamRequestKindSchema = z.enum(['spawn_agent', 'delegate_task', 'request_review']);
export type TeamRequestKind = z.infer<typeof teamRequestKindSchema>;

/**
 * A leader's request to Hive Teams and how it was decided. Its id comes from the requesting
 * task and the leader's own key for it, so the same request made again gets the same answer.
 */
export const teamRequestSchema = z.object({
  id: z.string(),
  runId: z.string(),
  kind: teamRequestKindSchema,
  /** The leader's name for this request, unique within its task (e.g. "codex", "implementar"). */
  key: z.string().min(1).max(60),
  requestedByAgentId: z.string(),
  requestedByTaskId: z.string(),
  status: z.enum(['accepted', 'rejected']),
  /** Why a request was refused, in words the leader can act on. */
  reason: z.string().nullable(),
  input: z.record(z.string(), z.unknown()),
  result: z.object({ agentId: z.string().optional(), taskId: z.string().optional() }),
  createdAt: z.string(),
});
export type TeamRequest = z.infer<typeof teamRequestSchema>;

/**
 * Limits that hold for every team, whatever a leader asks. A member never gets more than its
 * leader: these only narrow that further.
 */
export const teamsSettingsSchema = z.object({
  /**
   * Off by default: the Queen is not told about team leaders and no agent gets the team tools,
   * so missions run exactly as before until the user turns Hive Teams on.
   */
  enabled: z.boolean().default(false),
  /**
   * On by default: members are created only on models that cost nothing extra (free models,
   * free tiers, a local server or the ChatGPT plan already paid). A paid model is refused even
   * when a leader asks for it by name.
   */
  freeOnly: z.boolean().default(true),
  /** Agents Hive Teams may create in one mission, across all its teams. */
  maxAgentsPerRun: z.number().int().min(0).max(20),
  /** Members one leader may have. */
  maxTeamSize: z.number().int().min(0).max(10),
  /** How deep a hierarchy may go: 1 lets leaders create members that cannot create others. */
  maxDepth: z.number().int().min(1).max(3),
  /** Tasks one leader may delegate, reviews included. */
  maxDelegationsPerLead: z.number().int().min(1).max(20),
  /** Times a review may send the same task back for changes. */
  maxReviewRounds: z.number().int().min(0).max(5),
  /** Times a leader is resumed to consolidate (each resume may delegate again). */
  maxLeaderResumes: z.number().int().min(1).max(5),
  /** Token budget of one team: the sum of its members' limits may not pass it. */
  teamTokenBudget: z.number().int().min(10_000).max(100_000_000),
});
export type TeamsSettings = z.infer<typeof teamsSettingsSchema>;

export const defaultTeamsSettings: TeamsSettings = {
  enabled: false,
  freeOnly: true,
  maxAgentsPerRun: 6,
  maxTeamSize: 4,
  maxDepth: 1,
  maxDelegationsPerLead: 8,
  maxReviewRounds: 2,
  maxLeaderResumes: 3,
  teamTokenBudget: 6_000_000,
};
