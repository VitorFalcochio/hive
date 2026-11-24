import { z } from 'zod';

/**
 * Hive Guardian: health checks, incidents and recoveries of the hive itself. Everything here is
 * computed in the main process from facts (the database, git, processes, the run log); no model
 * is asked anything.
 */

export type HealthStatus = 'ok' | 'warn' | 'fail';
export type IncidentSeverity = 'info' | 'warning' | 'critical';

/** One component's health at the last check. */
export interface HealthCheck {
  id: string;
  name: string;
  status: HealthStatus;
  /** What was found, in words for the user. */
  detail: string;
  checkedAt: string;
  /** How long the check took, for the technical view. */
  durationMs: number;
}

/** A problem the Guardian found, open until the check that found it passes again. */
export interface GuardianIncident {
  id: string;
  /** Same key while the same problem lasts, so it is one incident and not one per check. */
  key: string;
  severity: IncidentSeverity;
  component: string;
  title: string;
  detail: string;
  openedAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  runId: string | null;
  taskId: string | null;
  /** The recovery the user can start for it, if any. */
  action: GuardianActionKind | null;
}

/** An agent at work, as the Guardian sees it: when it last showed a sign of life. */
export interface AgentHeartbeat {
  taskId: string;
  runId: string;
  taskTitle: string;
  workerId: string | null;
  workerName: string;
  state: string;
  /** Last event of the task; null when it never logged one. */
  lastSignal: string | null;
  silentMs: number;
  status: HealthStatus;
}

export interface ResourceUsage {
  /** Hive's processes together (main, windows, GPU, helpers). */
  cpuPercent: number;
  memoryMb: number;
  processes: { type: string; pid: number; cpuPercent: number; memoryMb: number }[];
  systemFreeMb: number;
  systemTotalMb: number;
  /** Free space where Hive keeps its data; null when the system does not say. */
  diskFreeMb: number | null;
}

/** A recovery that was started, kept as history. */
export interface RecoveryRecord {
  id: string;
  action: GuardianActionKind;
  target: string | null;
  at: string;
  ok: boolean;
  detail: string;
}

export interface GuardianLogLine {
  at: string;
  level: 'info' | 'warn' | 'error';
  scope: string;
  text: string;
}

export interface GuardianSnapshot {
  /** The hive as a whole: the worst of its components and open incidents. */
  status: HealthStatus;
  checkedAt: string | null;
  checks: HealthCheck[];
  agents: AgentHeartbeat[];
  resources: ResourceUsage | null;
  incidents: GuardianIncident[];
  recoveries: RecoveryRecord[];
  logs: GuardianLogLine[];
}

/**
 * What the user can ask the Guardian to do. Each acts through the same calls the app already
 * uses, is safe to repeat, and the ones that remove or stop something ask for confirmation in
 * the page first.
 */
export const guardianActionKindSchema = z.enum([
  /** A failed task goes back to the queue (its worktree and branch are kept). */
  'retry-task',
  /** A task that stopped showing progress is cancelled; its branch keeps what it committed. */
  'cancel-task',
  /** Worktrees in Hive's own folder that no task owns any more are removed. */
  'prune-worktrees',
  /** Every model resting after a failure may be tried again now. */
  'reset-providers',
  /** A copy of the database and skills, before anything risky. */
  'backup',
  /** The windows' pages reload; missions run in the main process and go on. */
  'reload-windows',
]);
export type GuardianActionKind = z.infer<typeof guardianActionKindSchema>;

export const guardianActionSchema = z.object({
  action: guardianActionKindSchema,
  /** The task for retry-task and cancel-task. */
  target: z.string().min(1).max(100).optional(),
});
export type GuardianAction = z.infer<typeof guardianActionSchema>;

/** Actions that remove or stop something, and so ask before running. */
export const destructiveGuardianActions: ReadonlySet<GuardianActionKind> = new Set([
  'cancel-task',
  'prune-worktrees',
  'reload-windows',
]);
