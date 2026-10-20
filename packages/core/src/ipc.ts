import { z } from 'zod';
import {
  planSchema,
  providerKindSchema,
  settingsSchema,
  workerInputSchema,
  type AgentEvent,
  type Approval,
  type ConnectionTest,
  type Mission,
  type ModelInfo,
  type ProviderConfig,
  type Run,
  type Settings,
  type SkillDetail,
  type SkillSummary,
  type SkillValidation,
  type Task,
  type Worker,
  type Workspace,
} from './domain';

/**
 * The IPC contract. Each channel declares a Zod schema for its input (validated in the main
 * process before any handler runs) and a TypeScript output type. The preload script only
 * forwards channel names listed here.
 */
function channel<O>() {
  return <I extends z.ZodType>(input: I) => ({ input, output: undefined as unknown as O });
}

const id = z.string().min(1).max(100);
const none = z.undefined();

export interface AppInfo {
  version: string;
  platform: string;
  electron: string;
  node: string;
  dataDir: string;
  secretStorage: { available: boolean; backend: string };
}

export interface WorkspaceStatus {
  workspace: Workspace;
  branch: string | null;
  head: string | null;
  clean: boolean;
  changedFiles: number;
  worktrees: { path: string; branch: string | null }[];
}

export interface MissionDetail {
  mission: Mission;
  runs: Run[];
}

export interface RunDetail {
  run: Run;
  mission: Mission;
  tasks: Task[];
  approvals: Approval[];
}

export interface TaskDiff {
  taskId: string;
  branch: string | null;
  base: string;
  files: { path: string; status: string; insertions: number; deletions: number }[];
  patch: string;
  truncated: boolean;
}

export interface DashboardSummary {
  workspace: Workspace | null;
  recentMissions: (Mission & { lastRunStatus: Run['status'] | null })[];
  activeTasks: (Task & { workerName: string | null })[];
  recentRuns: (Run & { missionTitle: string })[];
  pendingApprovals: Approval[];
  usage: { promptTokens: number; completionTokens: number; runsCounted: number };
  providers: ProviderConfig[];
  workers: number;
}

export interface WorkerHistoryItem {
  task: Task;
  runId: string;
  missionTitle: string;
}

export const eventQuerySchema = z.object({
  runId: id.optional(),
  taskId: id.optional(),
  workerId: id.optional(),
  types: z.array(z.string()).optional(),
  levels: z.array(z.enum(['debug', 'info', 'warn', 'error'])).optional(),
  search: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(2_000).default(500),
  before: z.string().optional(),
});
export type EventQuery = z.input<typeof eventQuerySchema>;

export const ipcContract = {
  'app.info': channel<AppInfo>()(none),
  'app.openExternal': channel<void>()(z.url().max(500)),

  'settings.get': channel<Settings>()(none),
  'settings.update': channel<Settings>()(settingsSchema.partial()),

  'workspace.list': channel<Workspace[]>()(none),
  'workspace.pick': channel<Workspace | null>()(none),
  'workspace.activate': channel<Workspace>()(id),
  'workspace.active': channel<Workspace | null>()(none),
  'workspace.remove': channel<void>()(id),
  'workspace.status': channel<WorkspaceStatus>()(id),

  'provider.list': channel<ProviderConfig[]>()(none),
  'provider.save': channel<ProviderConfig>()(
    z.object({
      id: id.optional(),
      kind: providerKindSchema,
      name: z.string().min(1).max(80),
      baseUrl: z.url().max(300),
      enabled: z.boolean(),
    }),
  ),
  'provider.delete': channel<void>()(id),
  'provider.setKey': channel<ProviderConfig>()(z.object({ providerId: id, key: z.string().min(1).max(500) })),
  'provider.clearKey': channel<ProviderConfig>()(id),
  'provider.test': channel<ConnectionTest>()(id),
  'provider.models': channel<ModelInfo[]>()(z.object({ providerId: id, refresh: z.boolean() })),
  'provider.probeTools': channel<ModelInfo>()(z.object({ providerId: id, modelId: z.string().min(1).max(200) })),

  'worker.list': channel<Worker[]>()(none),
  'worker.save': channel<Worker>()(workerInputSchema),
  'worker.delete': channel<void>()(id),
  'worker.history': channel<WorkerHistoryItem[]>()(id),
  'worker.compatibility': channel<string[]>()(id),

  'skill.pickCatalog': channel<Settings>()(none),
  'skill.list': channel<SkillSummary[]>()(none),
  'skill.get': channel<SkillDetail>()(z.object({ name: z.string().min(1).max(64), source: z.enum(['skillforge', 'local']) })),
  'skill.validate': channel<SkillValidation>()(z.object({ name: z.string().min(1).max(64), source: z.enum(['skillforge', 'local']) })),
  'skill.validateDraft': channel<SkillValidation>()(z.string().max(200_000)),
  'skill.install': channel<SkillSummary>()(z.string().min(1).max(64)),
  'skill.saveLocal': channel<SkillSummary>()(z.object({ raw: z.string().min(1).max(200_000), originalName: z.string().max(64).optional() })),
  'skill.deleteLocal': channel<void>()(z.string().min(1).max(64)),

  'mission.list': channel<(Mission & { lastRunStatus: Run['status'] | null })[]>()(none),
  'mission.create': channel<MissionDetail & { runId: string }>()(z.object({ title: z.string().min(1).max(140), objective: z.string().min(1).max(10_000) })),
  'mission.get': channel<MissionDetail>()(id),
  'mission.delete': channel<void>()(id),

  'run.get': channel<RunDetail>()(id),
  'run.plan': channel<RunDetail>()(
    z.object({ runId: id, queenWorkerId: id }),
  ),
  'run.setPlan': channel<RunDetail>()(
    z.object({ runId: id, plan: planSchema }),
  ),
  'run.start': channel<RunDetail>()(id),
  'run.cancel': channel<RunDetail>()(id),

  'task.cancel': channel<void>()(id),
  'task.retry': channel<void>()(id),
  'task.approve': channel<Task>()(id),
  'task.reject': channel<Task>()(id),
  'task.diff': channel<TaskDiff>()(id),
  'task.list': channel<(Task & { missionTitle: string })[]>()(
    z.object({ runId: id.optional() }),
  ),

  'approval.resolve': channel<void>()(z.object({ approvalId: id, approve: z.boolean(), remember: z.boolean() })),
  'approval.pending': channel<Approval[]>()(none),

  'events.query': channel<AgentEvent[]>()(eventQuerySchema),
  'dashboard.summary': channel<DashboardSummary>()(none),

} as const;

export type IpcContract = typeof ipcContract;
export type IpcChannel = keyof IpcContract;
export type IpcInput<C extends IpcChannel> = z.input<IpcContract[C]['input']>;
export type IpcOutput<C extends IpcChannel> = IpcContract[C]['output'];

export const ipcChannels = Object.keys(ipcContract) as IpcChannel[];

/** Push notifications from the main process to the renderer. */
export type HivePush =
  | { kind: 'event'; event: AgentEvent }
  | { kind: 'changed'; entity: 'run' | 'task' | 'mission' | 'approval' | 'worker' | 'provider' | 'skill' | 'workspace' | 'settings'; id: string | null };

export const PUSH_CHANNEL = 'hive:push';
export const INVOKE_CHANNEL = 'hive:invoke';

/** Serialisable result envelope so errors cross IPC with a stable shape. */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

export interface HiveBridge {
  invoke<C extends IpcChannel>(
    channel: C,
    ...input: IpcInput<C> extends undefined ? [] : [IpcInput<C>]
  ): Promise<IpcOutput<C>>;
  subscribe(listener: (push: HivePush) => void): () => void;
}
