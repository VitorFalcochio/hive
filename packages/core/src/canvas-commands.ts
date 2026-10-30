import { z } from 'zod';
import { planTaskSchema, workerRoleSchema } from './domain';

const nodeId = z.string().min(1).max(160);
export const canvasViewSchema = z.enum(['workspace', 'agent', 'none']);
export const canvasQueenActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create_note'), text: z.string().max(8000) }).strict(),
  z.object({ type: z.literal('create_group'), title: z.string().min(1).max(80) }).strict(),
  z
    .object({
      type: z.literal('create_agent'),
      name: z.string().min(1).max(60),
      role: workerRoleSchema.exclude(['queen']),
    })
    .strict(),
  z.object({ type: z.literal('create_task'), task: planTaskSchema.strict() }).strict(),
  z.object({ type: z.literal('set_view'), view: canvasViewSchema }).strict(),
  z.object({ type: z.literal('focus_node'), nodeId }).strict(),
  z.object({ type: z.literal('organize') }).strict(),
  z.object({ type: z.literal('open_result') }).strict(),
  z.object({ type: z.literal('inspect_mission') }).strict(),
  z.object({ type: z.literal('open_logs') }).strict(),
]);
export type CanvasQueenAction = z.infer<typeof canvasQueenActionSchema>;
export const canvasQueenPlanSchema = z
  .object({
    answer: z.string().min(1).max(12_000),
    actions: z.array(canvasQueenActionSchema).max(8),
  })
  .strict();
export const canvasQueenRequestSchema = z.object({
  runId: z.string().min(1).max(100),
  instruction: z.string().trim().min(1).max(4000),
  mode: z.enum(['ask', 'explain', 'progress', 'suggest']).default('ask'),
  selectedNodeIds: z.array(nodeId).max(100).default([]),
  view: canvasViewSchema,
  center: z.object({
    x: z.number().min(-1_000_000).max(1_000_000),
    y: z.number().min(-1_000_000).max(1_000_000),
  }),
});
export type CanvasQueenRequest = z.infer<typeof canvasQueenRequestSchema>;
export interface CanvasQueenProposal {
  id: string;
  runId: string;
  answer: string;
  actions: CanvasQueenAction[];
  expiresAt: string;
  queen: { name: string; modelId: string };
  usage: { promptTokens: number; completionTokens: number } | null;
}
export interface CanvasQueenApplied {
  applied: string[];
  /** Only viewport/panel actions; persistent changes already passed through real services. */
  effects: CanvasQueenAction[];
  error: string | null;
}

export function queenActionLabel(action: CanvasQueenAction): string {
  switch (action.type) {
    case 'create_note':
      return `Criar nota espacial: ${action.text.slice(0, 100) || '(vazia)'}`;
    case 'create_group':
      return `Criar grupo: ${action.title}`;
    case 'create_agent':
      return `Criar agente no Workspace: ${action.name} (${action.role}); configurar modelo depois`;
    case 'create_task':
      return `Adicionar tarefa: ${action.task.title} — ${action.task.description}`;
    case 'set_view':
      return `Alternar visualização: ${action.view}`;
    case 'focus_node':
      return `Encontrar elemento: ${action.nodeId}`;
    case 'organize':
      return 'Organizar automaticamente, preservando posições fixadas';
    case 'open_result':
      return 'Abrir Resultado Vivo existente';
    case 'inspect_mission':
      return 'Inspecionar missão';
    case 'open_logs':
      return 'Abrir Live Logs';
  }
}
