import { z } from 'zod';
import type { ToolName } from './domain';

/**
 * Direct Agent Chat: a conversation with one agent of the team, in one project, without a
 * mission or the Queen. Each request runs the agent on Hive's own runtime (the same engine,
 * policies and approvals as missions and the terminal `agents` command).
 */

/**
 * 'conversation' only reads the project (questions, analysis, planning); 'execution' may edit
 * files and run commands, under the agent's tools and the approval settings.
 */
export const agentChatModeSchema = z.enum(['conversation', 'execution']);
export type AgentChatMode = z.infer<typeof agentChatModeSchema>;

/** Tools that never change the project or run anything: all a conversation may use. */
export const READ_ONLY_TOOLS: readonly ToolName[] = [
  'list_dir',
  'read_file',
  'search',
  'read_skill_resource',
  'web_fetch',
  'view_page',
];

export const agentChatSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  workerId: z.string(),
  /** The first request, shortened; until then "Nova conversa". */
  title: z.string().max(120),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentChat = z.infer<typeof agentChatSchema>;

/** One thing the agent did while answering: a tool call, a notice, an approval, the Nectar. */
export const agentChatStepSchema = z.object({
  kind: z.enum(['tool', 'note', 'memory', 'approval', 'warn', 'error']),
  label: z.string().max(400),
  /** 'running' until a tool's result arrives. */
  status: z.enum(['running', 'ok', 'error']),
  /** Short output or detail, shown when the step is opened. */
  detail: z.string().max(2_000).optional(),
  at: z.string(),
});
export type AgentChatStep = z.infer<typeof agentChatStepSchema>;

/** At most this many steps are kept per reply; older ones are counted in `droppedSteps`. */
export const MAX_CHAT_STEPS = 150;

export const agentChatMessageStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'cancelled',
  /** Was running when Hive closed or crashed: never shown as finished. */
  'interrupted',
]);
export type AgentChatMessageStatus = z.infer<typeof agentChatMessageStatusSchema>;

export const agentChatMessageSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  role: z.enum(['user', 'agent']),
  mode: agentChatModeSchema,
  /** The request, or the agent's answer (Markdown). Empty while the agent works. */
  content: z.string().max(200_000),
  status: agentChatMessageStatusSchema,
  error: z.string().max(4_000).nullable(),
  /** Who answered: the agent's provider and model at the time, kept even if they change later. */
  model: z
    .object({
      providerId: z.string(),
      providerName: z.string().max(120),
      modelId: z.string().max(200),
      runtime: z.string().max(60),
    })
    .nullable(),
  steps: z.array(agentChatStepSchema).max(MAX_CHAT_STEPS),
  droppedSteps: z.number().int().min(0),
  /** Files the reply created or changed in the project folder (relative paths). */
  changedFiles: z.array(z.string().max(1_000)).max(500),
  usage: z.object({
    promptTokens: z.number().int().min(0),
    completionTokens: z.number().int().min(0),
  }),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type AgentChatMessage = z.infer<typeof agentChatMessageSchema>;

/** A command the agent is waiting to run, answered in the chat. */
export interface AgentChatApproval {
  id: string;
  command: string;
}

/** Where a conversation stands now, for a page that opens while the agent is working. */
export interface AgentChatState {
  chatId: string;
  running: boolean;
  approval: AgentChatApproval | null;
}
