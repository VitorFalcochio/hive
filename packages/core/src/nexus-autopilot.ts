import { z } from 'zod';
import { planTaskSchema, workerRoleSchema } from './domain';

const id = z.string().min(1).max(100);
const key = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-_]*$/i, 'Use letras, números, hífen ou sublinhado.');

export const nexusAutopilotAgentSchema = z.discriminatedUnion('source', [
  z
    .object({
      source: z.literal('existing'),
      key,
      workerId: id,
    })
    .strict(),
  z
    .object({
      source: z.literal('new'),
      key,
      name: z.string().trim().min(1).max(60),
      role: workerRoleSchema.exclude(['queen']),
      providerId: id,
      modelId: z.string().min(1).max(200),
    })
    .strict(),
]);
export type NexusAutopilotAgent = z.infer<typeof nexusAutopilotAgentSchema>;

export const nexusAutopilotTaskSchema = planTaskSchema
  .omit({ workerId: true })
  .extend({ workerKey: key.nullable() })
  .strict();
export type NexusAutopilotTask = z.infer<typeof nexusAutopilotTaskSchema>;

/**
 * Access to an existing Nectar block for an agent of the flow. Only Read and Propose: Approve and
 * Manage are given by the user on the canvas. Existing connections are never changed.
 */
export const nexusAutopilotCortexAccessSchema = z
  .object({
    cortexId: id,
    agentKey: key,
    permissions: z
      .array(z.enum(['read', 'propose']))
      .min(1)
      .max(2),
  })
  .strict();
export type NexusAutopilotCortexAccess = z.infer<typeof nexusAutopilotCortexAccessSchema>;

type FlowShape = {
  agents: NexusAutopilotAgent[];
  tasks: NexusAutopilotTask[];
  cortexAccess?: NexusAutopilotCortexAccess[] | undefined;
};

/** Unique keys, declared agents, no self-dependency and no cycle among the flow's own tasks. */
function refineFlow(draft: FlowShape, context: z.RefinementCtx): void {
  const agentKeys = new Set<string>();
  for (const [index, agent] of draft.agents.entries()) {
    if (agentKeys.has(agent.key))
      context.addIssue({
        code: 'custom',
        path: ['agents', index, 'key'],
        message: `Agente repetido: ${agent.key}.`,
      });
    agentKeys.add(agent.key);
  }
  const taskKeys = new Set<string>();
  for (const [index, task] of draft.tasks.entries()) {
    if (taskKeys.has(task.key))
      context.addIssue({
        code: 'custom',
        path: ['tasks', index, 'key'],
        message: `Tarefa repetida: ${task.key}.`,
      });
    taskKeys.add(task.key);
    if (task.workerKey && !agentKeys.has(task.workerKey))
      context.addIssue({
        code: 'custom',
        path: ['tasks', index, 'workerKey'],
        message: `Agente desconhecido: ${task.workerKey}.`,
      });
    if (task.dependsOn.includes(task.key))
      context.addIssue({
        code: 'custom',
        path: ['tasks', index, 'dependsOn'],
        message: 'Uma tarefa não pode depender de si mesma.',
      });
  }
  for (const [index, access] of (draft.cortexAccess ?? []).entries())
    if (!agentKeys.has(access.agentKey))
      context.addIssue({
        code: 'custom',
        path: ['cortexAccess', index, 'agentKey'],
        message: `Agente desconhecido no acesso ao Nectar: ${access.agentKey}.`,
      });
  const byKey = new Map(draft.tasks.map((task) => [task.key, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskKey: string): boolean => {
    if (visiting.has(taskKey)) return true;
    if (visited.has(taskKey)) return false;
    visiting.add(taskKey);
    for (const dependency of byKey.get(taskKey)?.dependsOn ?? [])
      if (byKey.has(dependency) && visit(dependency)) return true;
    visiting.delete(taskKey);
    visited.add(taskKey);
    return false;
  };
  for (const task of draft.tasks)
    if (visit(task.key)) {
      context.addIssue({
        code: 'custom',
        path: ['tasks'],
        message: 'O fluxo contém uma dependência circular.',
      });
      break;
    }
}

/** The model may only fill this declarative shape. It never receives executable tools. */
export const nexusAutopilotDraftSchema = z
  .object({
    objective: z.string().trim().min(1).max(4_000),
    agents: z.array(nexusAutopilotAgentSchema).max(12),
    tasks: z.array(nexusAutopilotTaskSchema).min(1).max(30),
    /** Resultado Vivo is a mission singleton and always receives real run events. */
    connectResult: z.literal(true),
    approvalSteps: z.array(z.string().trim().min(1).max(300)).max(10),
    warnings: z.array(z.string().trim().min(1).max(500)).max(20),
    cortexAccess: z.array(nexusAutopilotCortexAccessSchema).max(24).optional(),
  })
  .strict()
  .superRefine((draft, context) => refineFlow(draft, context));
export type NexusAutopilotDraft = z.infer<typeof nexusAutopilotDraftSchema>;

export const nexusAutopilotRequestSchema = z
  .object({
    runId: id,
    instruction: z.string().trim().min(1).max(6_000),
    useExistingAgents: z.boolean(),
    allowNewAgents: z.boolean(),
    basePlanId: id.optional(),
  })
  .strict()
  .refine((request) => request.useExistingAgents || request.allowNewAgents, {
    message: 'Permita agentes existentes ou a sugestão de novos agentes.',
  });
export type NexusAutopilotRequest = z.infer<typeof nexusAutopilotRequestSchema>;

export const nexusAutopilotStateSchema = z.enum([
  'proposed',
  'superseded',
  'applied',
  'started',
  'cancelled',
  'failed',
]);
export type NexusAutopilotState = z.infer<typeof nexusAutopilotStateSchema>;

export const nexusAutopilotPlanSchema = z
  .object({
    id,
    runId: id,
    missionId: id,
    version: z.number().int().positive(),
    origin: z.enum(['autopilot', 'manual']),
    state: nexusAutopilotStateSchema,
    instruction: z.string().max(6_000),
    useExistingAgents: z.boolean(),
    allowNewAgents: z.boolean(),
    draft: nexusAutopilotDraftSchema,
    basedOnPlanId: id.nullable(),
    changeSummary: z.string().max(500),
    createdAt: z.string(),
    updatedAt: z.string(),
    queen: z.object({ name: z.string(), modelId: z.string() }),
    usage: z
      .object({
        promptTokens: z.number().int().nonnegative(),
        completionTokens: z.number().int().nonnegative(),
      })
      .nullable(),
    fingerprint: z.string(),
    applied: z
      .object({
        agentIds: z.record(z.string(), z.string()),
        taskIds: z.record(z.string(), z.string()),
        started: z.boolean(),
        at: z.string(),
      })
      .nullable(),
    error: z.string().nullable(),
  })
  .strict();
export type NexusAutopilotPlan = z.infer<typeof nexusAutopilotPlanSchema>;

export const nexusAutopilotRevisionSchema = z
  .object({
    runId: id,
    planId: id,
    draft: nexusAutopilotDraftSchema,
    changeSummary: z.string().trim().min(1).max(500),
  })
  .strict();

export interface NexusAutopilotApplyResult {
  plan: NexusAutopilotPlan;
  createdAgents: number;
  createdTasks: number;
  started: boolean;
  alreadyApplied: boolean;
}

/* ------------------------------------------------- Adaptive replanning (Autopilot 2.0) */

/**
 * How the Queen proposes to get past a failed task. `replace` redoes it another way, `split`
 * breaks it into smaller steps, `reassign` hands the same work to another agent or model and
 * `skip` lets the waiting tasks go on without it.
 */
export const nexusAutopilotRecoveryStrategySchema = z.enum([
  'replace',
  'split',
  'reassign',
  'skip',
]);
export type NexusAutopilotRecoveryStrategy = z.infer<typeof nexusAutopilotRecoveryStrategySchema>;

/**
 * A patch, not a new plan: it only adds tasks (and agents for them). The tasks that waited on the
 * failed one wait on `resumeFrom` instead. Running and finished tasks are never changed.
 */
export const nexusAutopilotRecoveryDraftSchema = z
  .object({
    strategy: nexusAutopilotRecoveryStrategySchema,
    /** Why the task failed, from the real error. */
    diagnosis: z.string().trim().min(1).max(1_000),
    /** Why this path should work where the last one did not. */
    rationale: z.string().trim().min(1).max(1_000),
    agents: z.array(nexusAutopilotAgentSchema).max(4),
    tasks: z.array(nexusAutopilotTaskSchema).max(6),
    /** New tasks the waiting tasks depend on from now on; empty only to skip. */
    resumeFrom: z.array(key).max(6),
    warnings: z.array(z.string().trim().min(1).max(500)).max(10),
  })
  .strict()
  .superRefine((draft, context) => {
    refineFlow(draft, context);
    const skip = draft.strategy === 'skip';
    if (skip && (draft.tasks.length || draft.resumeFrom.length))
      context.addIssue({
        code: 'custom',
        path: ['tasks'],
        message: 'Pular a tarefa não cria tarefas novas.',
      });
    if (!skip && (!draft.tasks.length || !draft.resumeFrom.length))
      context.addIssue({
        code: 'custom',
        path: ['resumeFrom'],
        message: 'A recuperação precisa de tarefas novas e de onde o ramo continua.',
      });
    const keys = new Set(draft.tasks.map((task) => task.key));
    for (const [index, resume] of draft.resumeFrom.entries())
      if (!keys.has(resume))
        context.addIssue({
          code: 'custom',
          path: ['resumeFrom', index],
          message: `O ramo continuaria de uma tarefa que não está na recuperação: ${resume}.`,
        });
  });
export type NexusAutopilotRecoveryDraft = z.infer<typeof nexusAutopilotRecoveryDraftSchema>;

/**
 * - proposing: the Queen is working on it; the branch is already held.
 * - proposed: waiting for approval.
 * - applying / applied: the patch is going in / went in.
 * - dismissed: the user let the branch end as it would have without replanning.
 * - exhausted: a limit was hit; nothing was asked of the Queen and the branch needs the user.
 * - failed: the proposal or its application did not work; the branch needs the user.
 * - superseded: the task was retried or failed again and a newer record took over.
 */
export const nexusAutopilotRecoveryStateSchema = z.enum([
  'proposing',
  'proposed',
  'applying',
  'applied',
  'dismissed',
  'exhausted',
  'failed',
  'superseded',
]);
export type NexusAutopilotRecoveryState = z.infer<typeof nexusAutopilotRecoveryStateSchema>;

/** States in which the failed task's dependents keep waiting instead of being cancelled. */
export const recoveryHoldStates: ReadonlySet<NexusAutopilotRecoveryState> = new Set([
  'proposing',
  'proposed',
  'applying',
  'exhausted',
  'failed',
]);

export const nexusAutopilotRecoverySchema = z
  .object({
    id,
    runId: id,
    missionId: id,
    taskId: id,
    taskKey: z.string().min(1).max(100),
    taskTitle: z.string().max(200),
    /** The original task of the chain: a replacement that fails counts against the same one. */
    rootTaskKey: z.string().min(1).max(100),
    /** 1 for the first replan of the chain, 2 for a replan of its replacement, … */
    attempt: z.number().int().positive(),
    error: z.string().max(2_000),
    /** The error with numbers, ids and paths removed, to notice the same failure coming back. */
    signature: z.string().max(300),
    /** Keys of the tasks held while this record is open. */
    dependents: z.array(z.string()).max(40),
    state: nexusAutopilotRecoveryStateSchema,
    draft: nexusAutopilotRecoveryDraftSchema.nullable(),
    /** Why the record is exhausted, failed or dismissed. */
    reason: z.string().max(1_000).nullable(),
    queen: z.object({ name: z.string(), modelId: z.string() }).nullable(),
    usage: z
      .object({
        promptTokens: z.number().int().nonnegative(),
        completionTokens: z.number().int().nonnegative(),
      })
      .nullable(),
    applied: z
      .object({
        agentIds: z.record(z.string(), z.string()),
        taskIds: z.record(z.string(), z.string()),
        at: z.string(),
      })
      .nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type NexusAutopilotRecovery = z.infer<typeof nexusAutopilotRecoverySchema>;

/** Same failure, whatever the line number, temp path, id or duration that came with it. */
export function failureSignature(error: string): string {
  return error
    .toLowerCase()
    .replace(/[a-z]:[\\/][^\s'"`]*/g, '<path>')
    .replace(/(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+/g, '<path>')
    .replace(/\b[0-9a-f]{7,}\b/g, '<id>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/[\s'"`]+/g, ' ')
    .trim()
    .slice(0, 300);
}
