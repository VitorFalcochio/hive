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
  })
  .strict()
  .superRefine((draft, context) => {
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
  });
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
