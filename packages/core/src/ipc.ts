import { z } from 'zod';
import type { LiveResult, MissionNote, ResultEventPage } from './live-result';
import { guardianActionSchema, type GuardianSnapshot, type RecoveryRecord } from './guardian';
import {
  canvasQueenRequestSchema,
  type CanvasQueenApplied,
  type CanvasQueenProposal,
} from './canvas-commands';
import {
  nexusAutopilotRequestSchema,
  nexusAutopilotRevisionSchema,
  type NexusAutopilotApplyResult,
  type NexusAutopilotPlan,
  type NexusAutopilotRecovery,
} from './nexus-autopilot';
import {
  cortexActivityQuerySchema,
  cortexConnectSchema,
  cortexCreateSchema,
  cortexDraftSchema,
  cortexEditSchema,
  cortexMemoryQuerySchema,
  cortexPermissionsSchema,
  cortexResolveSchema,
  cortexRevokeSchema,
  cortexUpdateSchema,
  type CortexActivity,
  type CortexMemory,
  type CortexOverview,
  type CortexProposal,
  type CortexSearchResult,
} from './cortex';
import {
  agentChatModeSchema,
  type AgentChat,
  type AgentChatApproval,
  type AgentChatMessage,
  type AgentChatState,
} from './agent-chat';
import {
  mcpServerSchema,
  planSchema,
  planTaskSchema,
  workerRoleSchema,
  providerKindSchema,
  reviewCommentSchema,
  settingsSchema,
  workerInputSchema,
  type AgentEvent,
  type Approval,
  type ConnectionTest,
  type Mission,
  type ModelInfo,
  type ProviderConfig,
  type ProviderKind,
  type Run,
  type Settings,
  type SkillDetail,
  type SkillSummary,
  type SkillValidation,
  type Task,
  type Requirement,
  type Worker,
  type WorkerState,
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

export interface McpProbe {
  tools: { name: string; description: string }[];
}

export interface AppInfo {
  version: string;
  platform: string;
  electron: string;
  node: string;
  dataDir: string;
  secretStorage: { available: boolean; backend: string };
}

export interface BackupInfo {
  /** File name inside the backups folder. */
  name: string;
  kind: 'auto' | 'manual' | 'pre-restore';
  createdAt: string;
  size: number;
}

export interface BackupOverview {
  dir: string;
  items: BackupInfo[];
}

export type UpdateState =
  | { status: 'disabled'; reason: 'dev' | 'portable' }
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'none'; checkedAt: string }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string };

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
  /** What the plan said the mission must deliver; empty for plans made before requirements. */
  requirements?: Requirement[];
  /** The delivery gate's verdict once the run ended; null before. */
  delivery?: RunDelivery | null;
}

/** Where one requirement stands when the run ends, and why, in words for the user. */
export interface DeliveryRequirement {
  id: string;
  text: string;
  /**
   * met: every task covering it finished and the final check passed. unverified: they finished
   * but the final check failed or could not run. pending: a task covering it did not finish.
   * uncovered: no task in the plan covered it.
   */
  status: 'met' | 'unverified' | 'pending' | 'uncovered';
  tasks: { key: string; title: string; status: Task['status'] }[];
  reason: string;
}

/**
 * The delivery gate: when a run ends, the work of every finished task is merged as one project,
 * on top of where the run started, and the plan's commands (build, tests) run on it. A mission
 * is "verified" only when they all pass and every requirement is met.
 */
export interface RunDelivery {
  status: 'checking' | 'verified' | 'pending';
  at: string;
  /** The integrated commit the commands ran on; null when it could not be made. */
  commit: string | null;
  checks: { command: string; ok: boolean; output: string }[];
  /** Why the commands could not run at all (parts that do not merge, no command), if so. */
  problem: string | null;
  requirements: DeliveryRequirement[];
  /** One line for the user: what was proven and what is missing. */
  summary: string;
  /** The finished work this verdict is about, so a new result is checked again. */
  fingerprint: string;
}

export interface TaskDiff {
  taskId: string;
  branch: string | null;
  base: string;
  files: { path: string; status: string; insertions: number; deletions: number }[];
  patch: string;
  truncated: boolean;
}

export interface ActiveChat {
  id: string;
  workspaceId: string;
  workerId: string;
  /** The request being answered, shortened. */
  title: string;
  state: WorkerState;
  /** Set for a Direct Agent Chat reply: the conversation it belongs to. */
  direct?: string;
}

export interface DashboardSummary {
  workspace: Workspace | null;
  recentMissions: (Mission & { lastRunStatus: Run['status'] | null })[];
  activeTasks: (Task & { workerName: string | null })[];
  /** Agents answering in a terminal (`agents`), in any open project. */
  activeChats: ActiveChat[];
  recentRuns: (Run & { missionTitle: string })[];
  pendingApprovals: Approval[];
  usage: { promptTokens: number; completionTokens: number; runsCounted: number };
  /** Tokens used since local midnight across all projects, against the daily budget. */
  today: { promptTokens: number; completionTokens: number; budget: number };
  /** Honey boosts given: since local midnight and in all. There is no cap. */
  honey: { today: number; total: number };
  providers: ProviderConfig[];
  workers: number;
}

/** One mission in the shift queue, first = the one in progress or next to start. */
export interface AutopilotQueueItem {
  runId: string;
  missionId: string;
  missionTitle: string;
  workspaceName: string;
  status: Run['status'];
  tasks: { total: number; done: number; failed: number };
}

export interface AutopilotStatus {
  enabled: boolean;
  /** Run being planned or executed by the shift right now. */
  currentRunId: string | null;
  queue: AutopilotQueueItem[];
  history: {
    runId: string;
    missionTitle: string;
    status: Run['status'];
    error: string | null;
    finishedAt: string;
  }[];
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

/** Image formats the editor shows as a picture instead of text, by lowercase extension. */
export const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};

/** MIME type of a path the editor shows as an image, or null for any other file. */
export function imageType(path: string): string | null {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? null : (IMAGE_TYPES[path.slice(dot).toLowerCase()] ?? null);
}

export interface ImageContent {
  path: string;
  mime: string;
  /** Null when the image is larger than the viewer loads. */
  dataUrl: string | null;
  size: number;
  mtimeMs: number;
}

export interface FileDiffContent {
  path: string;
  original: string;
  modified: string;
}

/** What the Design Mode knows about a clicked element, to find the file that renders it. */
export const elementHintSchema = z.object({
  tag: z.string().max(60),
  id: z.string().max(200).nullable(),
  classes: z.array(z.string().max(200)).max(12),
  text: z.string().max(400),
  source: z.object({ file: z.string().max(1_000), line: z.number().int().nullable() }).nullable(),
});
export type ElementHint = z.infer<typeof elementHintSchema>;

export interface LocateCandidate {
  path: string;
  line: number | null;
  score: number;
  /** 'framework': the dev build said so; 'match': found by searching the element's text. */
  reason: 'framework' | 'match';
}

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** One line that matched; `column` is 1-based in characters, `length` 0 when not located. */
export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  length: number;
  text: string;
}

export interface SearchResult {
  /** Files whose name matches. */
  files: string[];
  matches: SearchMatch[];
  /** True when there were more matches than the result holds. */
  truncated: boolean;
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

/** One mission run in the Nexus picker, across every project. */
export interface CanvasRunSummary {
  runId: string;
  missionId: string;
  missionTitle: string;
  workspaceId: string;
  workspaceName: string;
  status: Run['status'];
  createdAt: string;
  finishedAt: string | null;
  tasks: { total: number; done: number; running: number; failed: number };
}

/** Per task, what its finished attempt cost; null when the model's catalog has no price. */
export interface CanvasTaskUsage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
}

/**
 * Everything the Nexus draws for one run, read in one go from the same repositories the
 * scheduler writes. Live changes arrive afterwards as pushes; the window never keeps its own state.
 */
export interface CanvasSnapshot {
  detail: RunDetail;
  workspace: { id: string; name: string } | null;
  /** Every agent of the team (for pickers and agents placed by hand); no secrets or prompts. */
  workers: CanvasWorker[];
  /** Terminals this window opened, still known to the main process. */
  terminals: CanvasTerminal[];
  usage: Record<string, CanvasTaskUsage>;
  /** The run is being planned by the Queen right now. */
  planning: boolean;
  /** Position in the shift queue (0 = next or current), null when not queued. */
  queuePosition: number | null;
  /** Adaptive replans of this run that still need a decision, newest first. */
  recoveries: NexusAutopilotRecovery[];
  /** What each flow block did last, by block id. */
  flow?: Record<string, FlowBlockState>;
  /** Hive Teams: the messages between this run's agents, oldest first. Absent without a team. */
  teamMessages?: CanvasTeamMessage[];
  /** When the snapshot was read, for the "updated" hint and elapsed timers. */
  at: string;
}

export interface CanvasWorker {
  id: string;
  name: string;
  role: Worker['role'];
  beeColor: Worker['beeColor'];
  providerId: string | null;
  providerName: string | null;
  modelId: string | null;
  /** Hive Teams: who leads it, for agents a leader created in this run. */
  team?: { parentAgentId: string | null; createdByAgentId: string | null; depth: number };
}

/** One Hive Teams message as the canvas shows it: a short excerpt, no payload beyond the verdict. */
export interface CanvasTeamMessage {
  id: string;
  kind: 'spawn' | 'delegation' | 'review_request' | 'feedback' | 'report' | 'note';
  fromAgentId: string | null;
  toAgentId: string | null;
  fromTaskId: string | null;
  toTaskId: string | null;
  subject: string;
  body: string;
  verdict: string | null;
  createdAt: string;
}

/**
 * A terminal the canvas opened: beside an agent (a plain shell, or a conversation with it), or in
 * a Terminal block of its own (a shell, or Claude Code), in the project folder.
 */
export interface CanvasTerminal {
  session: TerminalSession;
  /** The agent it was opened beside; null in a Terminal block. */
  workerId: string | null;
  /** The Terminal block it lives in; null beside an agent. */
  blockId: string | null;
  kind: 'shell' | 'chat' | 'claude';
  /** Worktree of the task it was opened in; null for the project folder. */
  taskId: string | null;
}

/** What a Terminal block on the canvas runs. */
export type TerminalBlockKind = 'shell' | 'claude';

const coordinate = z.number().min(-1_000_000).max(1_000_000);
export const flowBlockKindSchema = z.enum(['schedule', 'check', 'approval', 'notify']);
export type FlowBlockKind = z.infer<typeof flowBlockKindSchema>;
const extent = z.number().min(40).max(5_000);
const layoutKey = z.string().min(1).max(160);

/**
 * The spatial layer of the Nexus: where things sit and how they look. It never reaches
 * the Queen or the scheduler; the execution graph (agents, tasks, dependencies) lives in runs
 * and tasks and changes only through validated engine calls.
 */
export const canvasLayoutSchema = z.object({
  version: z.literal(1),
  /**
   * Where the user put things, per view mode; anything else is placed automatically. A moved
   * node keeps its place when the plan grows; a `locked` one also survives "Reorganizar".
   */
  pinned: z.partialRecord(
    z.enum(['workspace', 'agent', 'none']),
    z.record(layoutKey, z.object({ x: coordinate, y: coordinate, locked: z.boolean().optional() })),
  ),
  /** Sizes of resized windows, notes and frames. */
  sizes: z.record(layoutKey, z.object({ width: extent, height: extent })),
  /** Agent windows shown as a compact card. */
  minimized: z.array(layoutKey).max(200),
  /** Agents put on this canvas by hand, beside the ones the plan uses. */
  agents: z.array(z.string().min(1).max(100)).max(30),
  notes: z
    .array(
      z.object({
        id: layoutKey,
        text: z.string().max(8_000),
        x: coordinate,
        y: coordinate,
        tone: z.enum(['plain', 'gold', 'cyan', 'rose']),
      }),
    )
    .max(100),
  frames: z
    .array(z.object({ id: layoutKey, title: z.string().max(80), x: coordinate, y: coordinate }))
    .max(50),
  /** Token meters: today's usage against the daily budget. Layouts saved before them have none. */
  meters: z
    .array(z.object({ id: layoutKey, x: coordinate, y: coordinate }))
    .max(10)
    .default([]),
  /**
   * Dialogue blocks: the run's conversation between the Queen and the agents, built from what
   * really happened (tasks handed out, started, delivered or failed, Hive Teams, checks, replans).
   */
  dialogues: z
    .array(z.object({ id: layoutKey, x: coordinate, y: coordinate }))
    .max(5)
    .default([]),
  /** Delivery blocks: each requirement of the mission and the final check of the merged work. */
  deliveries: z
    .array(z.object({ id: layoutKey, x: coordinate, y: coordinate }))
    .max(5)
    .default([]),
  /**
   * Provider blocks. A line from one to an agent makes the agent use that provider; the lines
   * drawn are the agents that use it now, so the canvas never shows a stale link.
   */
  providers: z
    .array(
      z.object({
        id: layoutKey,
        x: coordinate,
        y: coordinate,
        providerId: z.string().min(1).max(100).nullable(),
        /** Shown in full; otherwise a block with a provider is just its logo. */
        expanded: z.boolean().optional(),
      }),
    )
    .max(20)
    .default([]),
  /**
   * Terminal blocks: a real terminal on the canvas, in the project folder: a shell, or Claude
   * Code run by the user. Its size lives in `sizes`; its session, while it runs, in the main
   * process.
   */
  terminals: z
    .array(
      z.object({
        id: layoutKey,
        x: coordinate,
        y: coordinate,
        kind: z.enum(['shell', 'claude']),
      }),
    )
    .max(12)
    .default([]),
  /**
   * Flow blocks, like n8n nodes, that act on the real run: a schedule that starts it, a check
   * that runs a project command on a finished task, an approval gate before applying, and an OS
   * notification. The flow engine in the main process reads them with `links`.
   */
  flow: z
    .array(
      z.object({
        id: layoutKey,
        x: coordinate,
        y: coordinate,
        kind: flowBlockKindSchema,
        /** Schedule: "HH:MM", local time. */
        time: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
          .optional(),
        /** Schedule: days of the week (0 = Sunday); none means every day. */
        days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
        /** Check: the project command to run, such as "npm test". */
        command: z.string().trim().max(300).optional(),
        /** Check: how many times a failure goes back to the agent before it stops. */
        retries: z.number().int().min(0).max(3).optional(),
        /** Approval: apply on its own when everything before it passed. */
        auto: z.boolean().optional(),
      }),
    )
    .max(30)
    .default([]),
  /** Lines drawn between flow blocks and agents; `port` is the output they leave from. */
  links: z
    .array(
      z.object({
        id: layoutKey,
        source: layoutKey,
        target: layoutKey,
        port: z.enum(['out', 'pass', 'fail']).default('out'),
      }),
    )
    .max(120)
    .default([]),
});
export type CanvasLayout = z.infer<typeof canvasLayoutSchema>;
export type FlowBlock = CanvasLayout['flow'][number];
export type FlowLink = CanvasLayout['links'][number];

/** What a flow block did last, for its badge on the canvas. */
export interface FlowBlockState {
  status: 'running' | 'passed' | 'failed' | 'waiting' | 'done';
  detail: string;
  at: string;
  durationMs: number | null;
}

export const emptyCanvasLayout: CanvasLayout = {
  version: 1,
  pinned: {},
  sizes: {},
  minimized: [],
  agents: [],
  notes: [],
  frames: [],
  meters: [],
  dialogues: [],
  deliveries: [],
  providers: [],
  terminals: [],
  flow: [],
  links: [],
};

/** One step of an agent's model chain, in the order calls try them. */
export interface ModelRoutePlan {
  providerId: string;
  providerName: string;
  model: string;
  /** The agent's own model, a backup the user chose, or one Hive picked from other providers. */
  source: 'primary' | 'backup' | 'automatic';
  /** Milliseconds it still rests after running out; 0 when ready. */
  restingMs: number;
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

  'backup.overview': channel<BackupOverview>()(none),
  /** A copy now, in the backups folder. */
  'backup.create': channel<BackupInfo>()(none),
  /** Hive Guardian: the last health check, incidents, agents, resources and recent log. */
  'guardian.snapshot': channel<GuardianSnapshot>()(none),
  /** Runs every health check now (manual diagnosis). */
  'guardian.diagnose': channel<GuardianSnapshot>()(none),
  /** Starts a recovery; the page confirms the ones that remove or stop something first. */
  'guardian.recover': channel<RecoveryRecord>()(guardianActionSchema),
  /** Saves the report, with credentials and personal paths removed, where the user picks. */
  'guardian.export': channel<string | null>()(none),
  /** A copy saved where the user picks; null when cancelled. */
  'backup.export': channel<string | null>()(none),
  /**
   * Restores a copy from the backups folder (by name) or one the user picks, after confirming.
   * Hive restarts to apply it; false when cancelled.
   */
  'backup.restore': channel<boolean>()(z.object({ name: z.string().max(200).optional() })),
  'backup.openFolder': channel<void>()(none),

  'update.status': channel<UpdateState>()(none),
  'update.check': channel<UpdateState>()(none),
  /** Restarts Hive into the downloaded version. */
  'update.install': channel<void>()(none),

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
  /**
   * Opens the browser for "Sign in with ChatGPT" and waits for the user to finish there. On
   * success the provider holds the account's tokens, like a key.
   */
  'provider.chatgptSignIn': channel<ProviderConfig>()(id),
  'provider.test': channel<ConnectionTest>()(id),
  /** Starts an MCP server once and lists its tools, without saving it. */
  'mcp.test': channel<McpProbe>()(mcpServerSchema),
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
  /** Where the agent's calls go, in order, when its model runs out (see Settings.failover). */
  'worker.routes': channel<ModelRoutePlan[]>()(id),

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
  'skill.restore': channel<SkillSummary>()(z.string().min(1).max(64)),

  'mission.list': channel<
    (Mission & {
      lastRunStatus: Run['status'] | null;
      pinned: boolean;
      /** Providers of the agents on the latest run's tasks, most-used first. */
      providerKinds: ProviderKind[];
    })[]
  >()(z.object({ workspaceId: id })),
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
  'task.boost': channel<Task>()(z.object({ id, boosted: z.boolean() })),
  /** Sends line comments on a finished task back to its agent for one revision pass. */
  'task.revise': channel<void>()(
    z.object({
      taskId: id,
      comments: z.array(reviewCommentSchema).max(100),
      note: z.string().max(4_000),
    }),
  ),
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
  /** Most likely files (best first) that render an element picked in the Design Mode. */
  'design.locate': channel<LocateCandidate[]>()(elementHintSchema),
  /** PNG data URL of a part of the Hive window, in window pixels (an element of the preview). */
  'design.capture': channel<string | null>()(
    z.object({
      x: z.number().min(0).max(20_000),
      y: z.number().min(0).max(20_000),
      width: z.number().min(1).max(20_000),
      height: z.number().min(1).max(20_000),
    }),
  ),
  'fs.search': channel<SearchResult>()(
    z.object({
      query: z.string().min(1).max(200),
      caseSensitive: z.boolean(),
      wholeWord: z.boolean(),
      regex: z.boolean(),
    }),
  ),
  'preview.serve': channel<{ url: string }>()(z.object({ path: relPath })),
  'fs.read': channel<FileContent>()(z.object({ path: relPath })),
  'fs.image': channel<ImageContent>()(z.object({ path: relPath })),
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
  /** An empty command opens the platform shell as an interactive terminal. */
  'terminal.start': channel<TerminalSession>()(
    z.object({
      command: z.string().trim().max(2_000),
      cwd: relPath.optional(),
      cols: z.number().int().min(2).max(500).optional(),
      rows: z.number().int().min(2).max(300).optional(),
    }),
  ),
  /** Keystrokes or pasted text for a running terminal. */
  'terminal.input': channel<void>()(z.object({ id, data: z.string().min(1).max(100_000) })),
  'terminal.resize': channel<void>()(
    z.object({
      id,
      cols: z.number().int().min(2).max(500),
      rows: z.number().int().min(2).max(300),
    }),
  ),
  'terminal.stop': channel<TerminalSession>()(id),
  'terminal.clear': channel<TerminalSession>()(id),
  /**
   * Direct Agent Chat: conversations with one agent in one project, newest first. Each
   * conversation belongs to a project and an agent; nothing crosses to another project.
   */
  'agentChat.list': channel<AgentChat[]>()(z.object({ workspaceId: id, workerId: id }).strict()),
  'agentChat.create': channel<AgentChat>()(z.object({ workspaceId: id, workerId: id }).strict()),
  'agentChat.delete': channel<void>()(id),
  /** Messages of a conversation, oldest first: the latest `limit`, or those before `before`. */
  'agentChat.messages': channel<{ messages: AgentChatMessage[]; more: boolean }>()(
    z
      .object({
        chatId: id,
        before: z.string().max(100).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      })
      .strict(),
  ),
  'agentChat.state': channel<AgentChatState>()(id),
  /**
   * Sends a request; the agent starts at once and works in the background. Its progress
   * arrives as `agentChat` pushes, and the reply is stored when it ends.
   */
  'agentChat.send': channel<{ user: AgentChatMessage; agent: AgentChatMessage }>()(
    z
      .object({
        chatId: id,
        text: z.string().trim().min(1).max(20_000),
        mode: agentChatModeSchema,
      })
      .strict(),
  ),
  /** Stops the agent working in this conversation; its reply is stored as cancelled. */
  'agentChat.cancel': channel<void>()(id),
  'agentChat.approve': channel<void>()(
    z.object({ chatId: id, approvalId: id, answer: z.enum(['yes', 'no', 'always']) }).strict(),
  ),
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

  /** Opens the Nexus in its own window, or brings it to the front when already open. */
  'window.openCanvas': channel<void>()(none),
  /** Brings the main window to the front with this run open, switching project if needed. */
  'window.showRun': channel<void>()(id),
  /** Brings the main window up on Provedores with the add form open (asked from the Nexus). */
  'window.addProvider': channel<void>()(none),
  'canvas.runs': channel<CanvasRunSummary[]>()(none),
  'canvas.queen.propose': channel<CanvasQueenProposal>()(canvasQueenRequestSchema),
  'canvas.queen.apply': channel<CanvasQueenApplied>()(z.object({ runId: id, proposalId: id })),
  'canvas.queen.cancel': channel<void>()(z.object({ runId: id, proposalId: id.optional() })),
  'canvas.autopilot.current': channel<NexusAutopilotPlan[]>()(id),
  'canvas.autopilot.propose': channel<NexusAutopilotPlan>()(nexusAutopilotRequestSchema),
  'canvas.autopilot.revise': channel<NexusAutopilotPlan>()(nexusAutopilotRevisionSchema),
  'canvas.autopilot.apply': channel<NexusAutopilotApplyResult>()(
    z.object({ runId: id, planId: id, start: z.boolean() }).strict(),
  ),
  'canvas.autopilot.cancel': channel<void>()(
    z.object({ runId: id, planId: id.optional() }).strict(),
  ),
  /** Adaptive replanning: apply the Queen's patch to the running mission. */
  'canvas.autopilot.recovery.apply': channel<NexusAutopilotRecovery>()(
    z.object({ runId: id, recoveryId: id }).strict(),
  ),
  /** Let the branch end: the tasks waiting on the failed one are cancelled, as without replanning. */
  'canvas.autopilot.recovery.dismiss': channel<NexusAutopilotRecovery>()(
    z.object({ runId: id, recoveryId: id }).strict(),
  ),
  /** Ask the Queen again after a proposal failed or was not good enough; limits still apply. */
  'canvas.autopilot.recovery.retry': channel<NexusAutopilotRecovery>()(
    z.object({ runId: id, recoveryId: id }).strict(),
  ),
  'canvas.snapshot': channel<CanvasSnapshot>()(id),
  /** The spatial layout of one run's canvas; visual only, never read by the engine. */
  'canvas.layout.get': channel<CanvasLayout>()(id),
  'canvas.result.get': channel<LiveResult>()(id),
  'canvas.result.events': channel<ResultEventPage>()(
    z
      .object({
        runId: id,
        after: z.number().int().nonnegative().optional(),
        before: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(500).default(100),
      })
      .refine(
        (value) => value.after === undefined || value.before === undefined,
        'Use apenas um cursor.',
      ),
  ),
  'canvas.notes.get': channel<MissionNote>()(id),
  'canvas.notes.save': channel<MissionNote>()(
    z.object({
      missionId: id,
      text: z.string().max(200_000),
      revision: z.number().int().nonnegative(),
    }),
  ),
  'canvas.layout.save': channel<void>()(z.object({ runId: id, layout: canvasLayoutSchema })),
  /** Commands the project offers for a check block (package scripts and the like). */
  'flow.commands': channel<string[]>()(id),
  /** Apply the tasks waiting at an approval block. */
  'flow.approve': channel<void>()(z.object({ runId: id, blockId: layoutKey })),
  /** Fire a schedule block now, as if its time had come. */
  'flow.trigger': channel<void>()(z.object({ runId: id, blockId: layoutKey })),
  /** Tokens spent today, live (running tasks included), against the daily budget. */
  'usage.today': channel<TokenMeter>()(none),
  /** Projects a mission can be created in, from the canvas. */
  'canvas.workspaces': channel<{ id: string; name: string }[]>()(none),
  'canvas.mission.create': channel<{ missionId: string; runId: string }>()(
    z.object({
      workspaceId: id,
      title: z.string().trim().min(1).max(140),
      objective: z.string().trim().min(1).max(10_000),
    }),
  ),
  /** Adds a task by hand; the scheduler checks key, dependencies, cycles and the agent. */
  'canvas.task.create': channel<Task>()(z.object({ runId: id, task: planTaskSchema })),
  /** A dependency drawn or removed on the canvas: `taskId` waits for `dependsOnTaskId`. */
  'canvas.task.link': channel<Task>()(
    z.object({ taskId: id, dependsOnTaskId: id, linked: z.boolean() }),
  ),
  /** Delegation drawn on the canvas: the task goes to this agent if it has not started. */
  'canvas.task.assign': channel<Task>()(z.object({ taskId: id, workerId: id })),
  /** A new agent made on the canvas from a role's preset. */
  'canvas.worker.create': channel<CanvasWorker>()(
    z.object({
      name: z.string().trim().min(1).max(60),
      role: workerRoleSchema.exclude(['queen']),
      providerId: id.nullable(),
      modelId: z.string().min(1).max(200).nullable(),
    }),
  ),
  /** Model for an agent; its next task (or conversation) uses it, a running one keeps its own. */
  'canvas.worker.setModel': channel<CanvasWorker>()(
    z.object({ workerId: id, providerId: id, modelId: z.string().min(1).max(200) }),
  ),
  /**
   * A real terminal beside an agent (`workerId`): a shell in the worktree of its live task (or
   * the project), or a conversation with it (the `agents` command, opened on that agent). Or one
   * in a Terminal block (`blockId`), in the project folder: a shell, or Claude Code (`claude`),
   * which the user drives with their own Claude Code sign-in.
   */
  'canvas.terminal.open': channel<CanvasTerminal>()(
    z.object({
      runId: id,
      workerId: id.optional(),
      blockId: layoutKey.optional(),
      kind: z.enum(['shell', 'chat', 'claude']),
      cols: z.number().int().min(2).max(500).optional(),
      rows: z.number().int().min(2).max(300).optional(),
    }),
  ),

  /** Nectar blocks of the run's project, with what the Nexus block shows. */
  'cortex.list': channel<CortexOverview[]>()(id),
  'cortex.create': channel<CortexOverview>()(cortexCreateSchema),
  'cortex.update': channel<CortexOverview>()(cortexUpdateSchema),
  /** Removes the block; its memories are kept for the project unless `purge`. */
  'cortex.delete': channel<void>()(z.object({ cortexId: id, purge: z.boolean() }).strict()),
  'cortex.connect': channel<CortexOverview>()(cortexConnectSchema),
  'cortex.disconnect': channel<CortexOverview>()(z.object({ cortexId: id, workerId: id }).strict()),
  'cortex.permissions': channel<CortexOverview>()(
    z.object({ cortexId: id, workerId: id, permissions: cortexPermissionsSchema }).strict(),
  ),
  'cortex.memories': channel<CortexMemory[]>()(cortexMemoryQuerySchema),
  'cortex.memory': channel<CortexMemory>()(id),
  /** The user writes a memory directly: it is approved by being written. */
  'cortex.memory.create': channel<CortexMemory>()(
    z.object({ cortexId: id, draft: cortexDraftSchema, supersedes: id.nullable() }).strict(),
  ),
  'cortex.memory.edit': channel<CortexMemory>()(cortexEditSchema),
  'cortex.memory.revoke': channel<CortexMemory>()(cortexRevokeSchema),
  'cortex.proposals': channel<CortexProposal[]>()(
    z
      .object({
        cortexId: id,
        status: z
          .array(z.enum(['pending', 'approved', 'rejected', 'changes_requested']))
          .optional(),
      })
      .strict(),
  ),
  'cortex.proposal.resolve': channel<CortexProposal>()(cortexResolveSchema),
  /** The Queen reads one proposal against the memories and records an opinion; she decides nothing. */
  'cortex.proposal.assess': channel<CortexProposal>()(z.object({ proposalId: id }).strict()),
  'cortex.activity': channel<CortexActivity[]>()(cortexActivityQuerySchema),
  /** The search the agents use, run by the user to check what they would receive. */
  'cortex.search': channel<CortexSearchResult>()(
    z.object({ cortexId: id, query: z.string().trim().min(1).max(500) }).strict(),
  ),

  'autopilot.status': channel<AutopilotStatus>()(none),
  'autopilot.setEnabled': channel<AutopilotStatus>()(z.boolean()),
  'autopilot.enqueue': channel<AutopilotStatus>()(id),
  'autopilot.dequeue': channel<AutopilotStatus>()(id),
  'autopilot.move': channel<AutopilotStatus>()(
    z.object({ runId: id, offset: z.union([z.literal(-1), z.literal(1)]) }),
  ),
} as const;

export type IpcContract = typeof ipcContract;
export type IpcChannel = keyof IpcContract;
export type IpcInput<C extends IpcChannel> = z.input<IpcContract[C]['input']>;
export type IpcOutput<C extends IpcChannel> = IpcContract[C]['output'];

export const ipcChannels = Object.keys(ipcContract) as IpcChannel[];

/**
 * What the Nexus window may call: reading runs and events, and the run and task actions
 * the scheduler already guards. Settings, files, terminals and secrets stay with the main window.
 */
export const canvasChannels: ReadonlySet<IpcChannel> = new Set<IpcChannel>([
  'app.info',
  'canvas.runs',
  'canvas.queen.propose',
  'canvas.queen.apply',
  'canvas.queen.cancel',
  'canvas.autopilot.current',
  'canvas.autopilot.propose',
  'canvas.autopilot.revise',
  'canvas.autopilot.apply',
  'canvas.autopilot.cancel',
  'canvas.autopilot.recovery.apply',
  'canvas.autopilot.recovery.dismiss',
  'canvas.autopilot.recovery.retry',
  'canvas.snapshot',
  'canvas.layout.get',
  'canvas.result.get',
  'canvas.result.events',
  'canvas.notes.get',
  'canvas.notes.save',
  'canvas.layout.save',
  'flow.commands',
  'flow.approve',
  'flow.trigger',
  'usage.today',
  // The Provider block: add a ChatGPT provider (the sign-in happens in the browser) and point an
  // agent at a provider. API keys are never typed here: the block sends you to the main window.
  'provider.save',
  'provider.chatgptSignIn',
  'provider.test',
  'worker.autoConfigure',
  'window.addProvider',
  'canvas.workspaces',
  'canvas.mission.create',
  'canvas.task.create',
  'canvas.task.link',
  'canvas.task.assign',
  'canvas.worker.create',
  'canvas.worker.setModel',
  'canvas.terminal.open',
  'cortex.list',
  'cortex.create',
  'cortex.update',
  'cortex.delete',
  'cortex.connect',
  'cortex.disconnect',
  'cortex.permissions',
  'cortex.memories',
  'cortex.memory',
  'cortex.memory.create',
  'cortex.memory.edit',
  'cortex.memory.revoke',
  'cortex.proposals',
  'cortex.proposal.resolve',
  'cortex.proposal.assess',
  'cortex.activity',
  'cortex.search',
  // Only for terminals this window opened; the main process checks the session (see index.ts).
  'terminal.input',
  'terminal.resize',
  'terminal.stop',
  'provider.list',
  'provider.models',
  'run.plan',
  'events.query',
  'run.start',
  'run.cancel',
  'task.cancel',
  'task.retry',
  'task.boost',
  'approval.resolve',
  'window.showRun',
]);

/** What the Tokens block shows: today's spend, by agent, against the daily budget. */
export interface TokenMeter {
  promptTokens: number;
  completionTokens: number;
  /** Settings' daily token budget; 0 when none is set. */
  budget: number;
  /** Biggest spenders first. */
  byWorker: { workerId: string | null; name: string; tokens: number }[];
  /** Since when the day counts (local midnight, ISO). */
  since: string;
}

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
  /** Sent to the main window only: open this run (asked for from the Nexus). */
  | { kind: 'navigate'; runId: string }
  /** Sent to the main window only: open the add-provider form (asked for from the Nexus). */
  | { kind: 'navigate'; page: 'add-provider' }
  /** Sent to the main window only: where the app update stands. */
  | { kind: 'update'; state: UpdateState }
  /** Direct Agent Chat: a reply changed (a step, an approval, the end). Not a reload. */
  | {
      kind: 'agentChat';
      chatId: string;
      workspaceId: string;
      message: AgentChatMessage;
      approval: AgentChatApproval | null;
    }
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
        | 'settings'
        | 'autopilot'
        | 'chat'
        | 'result'
        | 'missionNote'
        | 'cortex'
        /** The main process changed a run's canvas layout (the Queen built its flow). */
        | 'layout'
        /** Hive Guardian checked the hive again. */
        | 'guardian';
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
