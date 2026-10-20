import { z } from 'zod';

/* ---------------------------------------------------------------- Workspace */

export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  defaultBranch: z.string(),
  createdAt: z.string(),
  lastOpenedAt: z.string(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

/* ---------------------------------------------------------------- Providers and models */

export const providerKindSchema = z.enum([
  'openai',
  'groq',
  'nvidia',
  'deepseek',
  'openrouter',
  'openai-compatible',
]);
export type ProviderKind = z.infer<typeof providerKindSchema>;

/** `unknown` means Hive has not verified it; the UI must not present it as supported. */
export const capabilitySchema = z.enum(['yes', 'no', 'unknown']);
export type Capability = z.infer<typeof capabilitySchema>;

export const modelCapabilitiesSchema = z.object({
  tools: capabilitySchema,
  structuredOutput: capabilitySchema,
  reasoning: capabilitySchema,
});
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;

export const modelInfoSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  displayName: z.string(),
  family: z.string().nullable(),
  contextWindow: z.number().int().positive().nullable(),
  capabilities: modelCapabilitiesSchema,
  /** How the capability information was obtained. */
  capabilitySource: z.enum(['provider-metadata', 'probe', 'unverified']),
  /** USD per million tokens when the provider publishes it; null when unknown. */
  pricing: z.object({ inputPerMTok: z.number(), outputPerMTok: z.number() }).nullable(),
});
export type ModelInfo = z.infer<typeof modelInfoSchema>;

export const connectionTestSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  at: z.string(),
  latencyMs: z.number().nullable(),
});
export type ConnectionTest = z.infer<typeof connectionTestSchema>;

export const providerConfigSchema = z.object({
  id: z.string(),
  kind: providerKindSchema,
  name: z.string().min(1).max(80),
  baseUrl: z.url(),
  enabled: z.boolean(),
  hasCredential: z.boolean(),
  credentialHint: z.string().nullable(),
  lastTest: connectionTestSchema.nullable(),
  modelsFetchedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

/* ---------------------------------------------------------------- Workers */

export const workerRoleSchema = z.enum([
  'queen',
  'architect',
  'frontend',
  'backend',
  'qa',
  'reviewer',
  'custom',
]);
export type WorkerRole = z.infer<typeof workerRoleSchema>;

export const workerStateSchema = z.enum([
  'idle',
  'planning',
  'thinking',
  'coding',
  'testing',
  'reviewing',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
]);
export type WorkerState = z.infer<typeof workerStateSchema>;

export const toolNameSchema = z.enum([
  'list_dir',
  'read_file',
  'search',
  'write_file',
  'replace_in_file',
  'run_command',
  'read_skill_resource',
]);
export type ToolName = z.infer<typeof toolNameSchema>;

export const executionLimitsSchema = z.object({
  maxSteps: z.number().int().min(1).max(200),
  /** Total prompt+completion token budget for one task attempt. */
  maxTokens: z.number().int().min(1_000).max(10_000_000),
  commandTimeoutSec: z.number().int().min(5).max(3_600),
  taskTimeoutMin: z.number().int().min(1).max(600),
  temperature: z.number().min(0).max(2).nullable(),
});
export type ExecutionLimits = z.infer<typeof executionLimitsSchema>;

export const workerSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(60),
  role: workerRoleSchema,
  description: z.string().max(500),
  providerId: z.string().nullable(),
  modelId: z.string().nullable(),
  skills: z.array(z.string()),
  tools: z.array(toolNameSchema),
  /** Commands that run without asking, matched as an exact string or `prefix *`. */
  autoApproveCommands: z.array(z.string().min(1).max(200)),
  systemPrompt: z.string().max(20_000),
  limits: executionLimitsSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Worker = z.infer<typeof workerSchema>;

export const workerInputSchema = workerSchema
  .omit({ createdAt: true, updatedAt: true })
  .extend({ id: z.string().optional() });
export type WorkerInput = z.infer<typeof workerInputSchema>;

/* ---------------------------------------------------------------- Missions, runs and tasks */

export const missionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string().min(1).max(140),
  objective: z.string().min(1).max(10_000),
  createdAt: z.string(),
});
export type Mission = z.infer<typeof missionSchema>;

export const runStatusSchema = z.enum([
  'draft',
  'planning',
  'awaiting_plan_approval',
  'running',
  'review',
  'completed',
  'failed',
  'cancelled',
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const runSchema = z.object({
  id: z.string(),
  missionId: z.string(),
  workspaceId: z.string(),
  status: runStatusSchema,
  baseBranch: z.string(),
  baseCommit: z.string(),
  queenWorkerId: z.string().nullable(),
  planNotes: z.string().nullable(),
  report: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type Run = z.infer<typeof runSchema>;

export const taskStatusSchema = z.enum([
  'pending',
  'blocked',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
  'approved',
  'rejected',
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const commandEvidenceSchema = z.object({
  command: z.string(),
  exitCode: z.number().nullable(),
  durationMs: z.number(),
  timedOut: z.boolean(),
  outputTail: z.string(),
});
export type CommandEvidence = z.infer<typeof commandEvidenceSchema>;

export const taskResultSchema = z.object({
  summary: z.string(),
  filesChanged: z.array(z.object({ path: z.string(), status: z.string() })),
  insertions: z.number().int(),
  deletions: z.number().int(),
  commit: z.string().nullable(),
  commands: z.array(commandEvidenceSchema),
  usage: z.object({ promptTokens: z.number(), completionTokens: z.number() }),
});
export type TaskResult = z.infer<typeof taskResultSchema>;

export const taskSchema = z.object({
  id: z.string(),
  runId: z.string(),
  key: z.string(),
  title: z.string(),
  description: z.string(),
  workerId: z.string().nullable(),
  dependsOn: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  status: taskStatusSchema,
  workerState: workerStateSchema,
  attempt: z.number().int(),
  branch: z.string().nullable(),
  /** Commit the task branch started from; its diff is computed against this. */
  startCommit: z.string().nullable(),
  worktreePath: z.string().nullable(),
  result: taskResultSchema.nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type Task = z.infer<typeof taskSchema>;

/** Plan shape produced by the Queen (or written by the user) and validated before use. */
export const planTaskSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-_]*$/i, 'Use letters, digits, dashes or underscores.'),
  title: z.string().min(1).max(140),
  description: z.string().min(1).max(4_000),
  workerId: z.string().nullable(),
  dependsOn: z.array(z.string()).max(10),
  acceptanceCriteria: z.array(z.string().min(1).max(400)).min(1).max(10),
});
export type PlanTask = z.infer<typeof planTaskSchema>;

export const planSchema = z.object({
  notes: z.string().max(4_000),
  tasks: z.array(planTaskSchema).min(1).max(12),
});
export type Plan = z.infer<typeof planSchema>;

/* ---------------------------------------------------------------- Events and approvals */

export const agentEventTypeSchema = z.enum([
  'run.status',
  'task.status',
  'worker.state',
  'session.started',
  'session.finished',
  'model.request',
  'model.response',
  'tool.call',
  'tool.result',
  'file.changed',
  'command.started',
  'command.finished',
  'approval.requested',
  'approval.resolved',
  'git',
  'plan',
  'error',
  'info',
]);
export type AgentEventType = z.infer<typeof agentEventTypeSchema>;

export const agentEventSchema = z.object({
  id: z.string(),
  ts: z.string(),
  workspaceId: z.string().nullable(),
  runId: z.string().nullable(),
  taskId: z.string().nullable(),
  workerId: z.string().nullable(),
  type: agentEventTypeSchema,
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).nullable(),
});
export type AgentEvent = z.infer<typeof agentEventSchema>;

export const approvalSchema = z.object({
  id: z.string(),
  runId: z.string(),
  taskId: z.string(),
  workerId: z.string().nullable(),
  kind: z.enum(['command']),
  title: z.string(),
  detail: z.string(),
  status: z.enum(['pending', 'approved', 'denied', 'expired']),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type Approval = z.infer<typeof approvalSchema>;

/* ---------------------------------------------------------------- Skills */

export const skillSourceSchema = z.enum(['skillforge', 'local']);

export const skillDiagnosticSchema = z.object({
  severity: z.enum(['error', 'warning']),
  code: z.string(),
  message: z.string(),
  file: z.string().nullable(),
});
export type SkillDiagnostic = z.infer<typeof skillDiagnosticSchema>;

export const skillSummarySchema = z.object({
  /** Skill identifier (the SKILL.md `name`), unique across sources once installed. */
  name: z.string(),
  source: skillSourceSchema,
  category: z.string(),
  description: z.string(),
  license: z.string().nullable(),
  compatibility: z.string().nullable(),
  allowedTools: z.string().nullable(),
  resources: z.array(z.string()),
  hasScripts: z.boolean(),
  installed: z.boolean(),
  directory: z.string(),
});
export type SkillSummary = z.infer<typeof skillSummarySchema>;

export const skillDetailSchema = skillSummarySchema.extend({
  body: z.string(),
  raw: z.string(),
});
export type SkillDetail = z.infer<typeof skillDetailSchema>;

export const skillValidationSchema = z.object({
  valid: z.boolean(),
  validator: z.enum(['hive', 'skillforge-cli']),
  diagnostics: z.array(skillDiagnosticSchema),
});
export type SkillValidation = z.infer<typeof skillValidationSchema>;

/* ---------------------------------------------------------------- Settings */

export const settingsSchema = z.object({
  maxConcurrentTasks: z.number().int().min(1).max(8),
  skillforgeCatalogPath: z.string().nullable(),
  skillforgeCliValidation: z.boolean(),
  defaultLimits: executionLimitsSchema,
  /** Token budget for a whole run across all tasks; 0 disables the run-level cap. */
  runTokenBudget: z.number().int().min(0),
  reduceMotion: z.enum(['system', 'on', 'off']),
  density: z.enum(['comfortable', 'compact']),
});
export type Settings = z.infer<typeof settingsSchema>;

export const defaultLimits: ExecutionLimits = {
  maxSteps: 40,
  maxTokens: 400_000,
  commandTimeoutSec: 180,
  taskTimeoutMin: 30,
  temperature: null,
};

export const defaultSettings: Settings = {
  maxConcurrentTasks: 2,
  skillforgeCatalogPath: null,
  skillforgeCliValidation: false,
  defaultLimits,
  runTokenBudget: 2_000_000,
  reduceMotion: 'system',
  density: 'comfortable',
};
