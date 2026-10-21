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
const relPath = z.string().max(1_000);
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

export interface RecommendedSetup {
  /** One entry per agent; `modelId` is null when no catalog model answered. */
  assignments: { workerId: string; workerName: string; modelId: string | null }[];
  /** Models that are listed by the provider but failed the test call. */
  unavailable: { modelId: string; message: string }[];
}

/* Editor: paths are relative to the workspace root, with forward slashes. */
export interface FileEntry {
  name: string;
  path: string;
  kind: 'file' | 'dir';
}

export interface FileContent {
  path: string;
  /** Null for binary or oversized files, which the editor does not open. */
  content: string | null;
  binary: boolean;
  tooLarge: boolean;
  size: number;
  mtimeMs: number;
}

export interface FileDiffContent {
  path: string;
  original: string;
  modified: string;
}

export interface GitStatusSummary {
  branch: string | null;
  files: { path: string; status: string }[];
}

export type TerminalStatus = 'running' | 'stopping' | 'exited' | 'failed' | 'stopped';

export interface TerminalSession {
  id: string;
  workspaceId: string;
  command: string;
  cwd: string;
  status: TerminalStatus;
  output: string;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  previewUrls: string[];
}

export type TerminalEvent =
  | { type: 'started'; session: TerminalSession }
  | { type: 'output'; sessionId: string; chunk: string; previewUrls: string[] }
  | { type: 'state'; session: TerminalSession };

export type CodeAssistantMode = 'explain' | 'review' | 'edit' | 'chat';

export interface CodeAssistantResponse {
  answer: string;
  proposal: { replacement: string; summary: string } | null;
  worker: { id: string; name: string; modelId: string };
  usage: { promptTokens: number; completionTokens: number } | null;
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
  'workspace.pick': channel<WorkspacePick>()(none),
  /** Turns a plain folder into a local Git repository with an initial commit, then opens it. */
  'workspace.initialize': channel<Workspace>()(z.object({ path: z.string().min(1).max(4096) })),
  'workspace.activate': channel<Workspace>()(id),
  'workspace.active': channel<Workspace | null>()(none),
  /** Projects open as tabs, in tab order. */
  'workspace.tabs': channel<Workspace[]>()(none),
  'workspace.close': channel<void>()(id),
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
  'provider.setKey': channel<ProviderConfig>()(
    z.object({ providerId: id, key: z.string().min(1).max(500) }),
  ),
  'provider.clearKey': channel<ProviderConfig>()(id),
  'provider.test': channel<ConnectionTest>()(id),
  'provider.models': channel<ModelInfo[]>()(z.object({ providerId: id, refresh: z.boolean() })),
  'provider.probeTools': channel<ModelInfo>()(
    z.object({ providerId: id, modelId: z.string().min(1).max(200) }),
  ),

  'provider.testModel': channel<ConnectionTest>()(
    z.object({ providerId: id, modelId: z.string().min(1).max(200) }),
  ),

  'worker.list': channel<Worker[]>()(none),
  'worker.applyRecommended': channel<RecommendedSetup>()(z.object({ providerId: id })),
  /** Picks, tests and saves the best model of one provider for one agent's role. */
  'worker.autoConfigure': channel<RecommendedSetup>()(z.object({ workerId: id, providerId: id })),
  'worker.save': channel<Worker>()(workerInputSchema),
  'worker.delete': channel<void>()(id),
  'worker.history': channel<WorkerHistoryItem[]>()(id),
  'worker.compatibility': channel<string[]>()(id),

  'skill.pickCatalog': channel<Settings>()(none),
  'skill.list': channel<SkillSummary[]>()(none),
  'skill.get': channel<SkillDetail>()(
    z.object({ name: z.string().min(1).max(64), source: z.enum(['skillforge', 'local']) }),
  ),
  'skill.validate': channel<SkillValidation>()(
    z.object({ name: z.string().min(1).max(64), source: z.enum(['skillforge', 'local']) }),
  ),
  'skill.validateDraft': channel<SkillValidation>()(z.string().max(200_000)),
  'skill.install': channel<SkillSummary>()(z.string().min(1).max(64)),
  'skill.saveLocal': channel<SkillSummary>()(
    z.object({ raw: z.string().min(1).max(200_000), originalName: z.string().max(64).optional() }),
  ),
  'skill.deleteLocal': channel<void>()(z.string().min(1).max(64)),

  'mission.list': channel<(Mission & { lastRunStatus: Run['status'] | null; pinned: boolean })[]>()(
    z.object({ workspaceId: id }),
  ),
  'mission.pin': channel<void>()(z.object({ id, pinned: z.boolean() })),
  'mission.create': channel<MissionDetail & { runId: string }>()(
    z.object({ title: z.string().min(1).max(140), objective: z.string().min(1).max(10_000) }),
  ),
  'mission.get': channel<MissionDetail>()(id),
  'mission.delete': channel<void>()(id),

  'run.get': channel<RunDetail>()(id),
  'run.plan': channel<RunDetail>()(z.object({ runId: id, queenWorkerId: id })),
  'run.setPlan': channel<RunDetail>()(z.object({ runId: id, plan: planSchema })),
  'run.start': channel<RunDetail>()(id),
  'run.cancel': channel<RunDetail>()(id),

  'task.cancel': channel<void>()(id),
  'task.retry': channel<void>()(id),
  'task.approve': channel<Task>()(id),
  'task.reject': channel<Task>()(id),
  'task.diff': channel<TaskDiff>()(id),
  'task.list': channel<(Task & { missionTitle: string })[]>()(z.object({ runId: id.optional() })),

  'approval.resolve': channel<void>()(
    z.object({ approvalId: id, approve: z.boolean(), remember: z.boolean() }),
  ),
  'approval.pending': channel<Approval[]>()(none),

  'events.query': channel<AgentEvent[]>()(eventQuerySchema),

  'fs.list': channel<FileEntry[]>()(z.object({ path: relPath })),
  'fs.files': channel<string[]>()(none),
  'preview.serve': channel<{ url: string }>()(z.object({ path: relPath })),
  'fs.read': channel<FileContent>()(z.object({ path: relPath })),
  'fs.write': channel<{ mtimeMs: number }>()(
    z.object({
      path: relPath,
      content: z.string().max(20_000_000),
      expectedMtimeMs: z.number().nullable(),
    }),
  ),
  'fs.create': channel<void>()(z.object({ path: relPath, kind: z.enum(['file', 'dir']) })),
  'fs.rename': channel<void>()(z.object({ from: relPath, to: relPath })),
  'fs.trash': channel<void>()(z.object({ path: relPath })),
  'git.status': channel<GitStatusSummary>()(none),
  'git.fileDiff': channel<FileDiffContent>()(z.object({ path: relPath })),
  'git.branches': channel<{ current: string | null; local: string[] }>()(none),
  'git.checkout': channel<void>()(z.string().min(1).max(250)),
  'task.fileDiff': channel<FileDiffContent>()(z.object({ taskId: id, path: relPath })),
  'terminal.list': channel<TerminalSession[]>()(none),
  'terminal.start': channel<TerminalSession>()(
    z.object({ command: z.string().trim().min(1).max(2_000), cwd: relPath.optional() }),
  ),
  'terminal.stop': channel<TerminalSession>()(id),
  'terminal.clear': channel<TerminalSession>()(id),
  'code.assist': channel<CodeAssistantResponse>()(
    z.object({
      workerId: id,
      mode: z.enum(['explain', 'review', 'edit', 'chat']),
      path: relPath,
      fileContent: z.string().max(1_000_000),
      selection: z
        .object({
          startOffset: z.number().int().min(0),
          endOffset: z.number().int().min(0),
          text: z.string().max(200_000),
        })
        .nullable(),
      instruction: z.string().trim().min(1).max(10_000),
      history: z
        .array(
          z.object({
            role: z.enum(['user', 'assistant']),
            content: z.string().min(1).max(12_000),
          }),
        )
        .max(12),
    }),
  ),
  'dashboard.summary': channel<DashboardSummary>()(none),
} as const;

export type IpcContract = typeof ipcContract;
export type IpcChannel = keyof IpcContract;
export type IpcInput<C extends IpcChannel> = z.input<IpcContract[C]['input']>;
export type IpcOutput<C extends IpcChannel> = IpcContract[C]['output'];

export const ipcChannels = Object.keys(ipcContract) as IpcChannel[];

/** Push notifications from the main process to the renderer. */
/** Result of picking a folder: opened, or a plain folder that must be initialized first. */
export type WorkspacePick =
  | { status: 'opened'; workspace: Workspace }
  | { status: 'needs-init'; path: string; name: string }
  | null;

export type HivePush =
  | { kind: 'event'; event: AgentEvent }
  /** Files changed on disk in a workspace that is open as a tab (relative paths). */
  | { kind: 'files'; workspaceId: string; paths: string[] }
  | { kind: 'terminal'; event: TerminalEvent }
  | {
      kind: 'changed';
      entity:
        | 'run'
        | 'task'
        | 'mission'
        | 'approval'
        | 'worker'
        | 'provider'
        | 'skill'
        | 'workspace'
        | 'settings';
      id: string | null;
    };

export const PUSH_CHANNEL = 'hive:push';
export const INVOKE_CHANNEL = 'hive:invoke';

/** Serialisable result envelope so errors cross IPC with a stable shape. */
export type IpcResult<T> =
  { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

export interface HiveBridge {
  invoke<C extends IpcChannel>(
    channel: C,
    ...input: IpcInput<C> extends undefined ? [] : [IpcInput<C>]
  ): Promise<IpcOutput<C>>;
  subscribe(listener: (push: HivePush) => void): () => void;
}
