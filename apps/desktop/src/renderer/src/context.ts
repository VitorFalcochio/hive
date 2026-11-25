import { createContext, useContext } from 'react';
import type {
  AgentEvent,
  HivePush,
  AppInfo,
  DashboardSummary,
  ProviderConfig,
  RunDetail,
  SkillSummary,
  Task,
  TerminalEvent,
  Worker,
  Workspace,
} from '@hive/core';
import { providerPresets } from '@hive/core';

export type View =
  | 'overview'
  | 'search'
  | 'mission'
  | 'code'
  | 'run'
  | 'shift'
  | 'agents'
  /** Direct Agent Chat with one agent (see `chatWorkerId`). */
  | 'agentChat'
  | 'providers'
  | 'skills'
  /** Hive Guardian: health, incidents and recoveries of the hive. */
  | 'guardian'
  /** Hive Browser: tabs the user and the agents drive. */
  /** Hive Marketplace: agents, teams and skills to install and share. */
  | 'marketplace'
  | 'settings'
  | 'about';

export type ModalState =
  /** `objective` and `mode` come filled in when the mission starts from the home prompt. */
  | { kind: 'mission'; objective?: string; mode?: MissionMode }
  | { kind: 'provider' }
  | { kind: 'key'; provider: ProviderConfig }
  | { kind: 'team'; providerId?: string }
  | { kind: 'model'; worker: Worker }
  | { kind: 'diff'; task: Task }
  | { kind: 'activity'; task: Task };

/** How a new mission runs: the Queen's plan, queued for the shift, or agents compared. */
export type MissionMode = 'plan' | 'queue' | 'compare';

export interface HiveContext {
  summary: DashboardSummary | null;
  workspaces: Workspace[];
  workers: Worker[];
  providers: ProviderConfig[];
  skills: SkillSummary[];
  info: AppInfo | null;
  detail: RunDetail | null;
  setDetail(detail: RunDetail | null): void;
  refresh(): Promise<void>;
  notify(text: string): void;
  fail(error: unknown): void;
  openModal(modal: ModalState): void;
  closeModal(): void;
  go(view: View): void;
  openMission(missionId: string): Promise<void>;
  openRun(runId: string): Promise<void>;
  /** Live agent events pushed by the main process. Returns an unsubscribe function. */
  onEvent(listener: (event: AgentEvent) => void): () => void;
  /** Workspace files changed on disk (relative paths). Returns an unsubscribe function. */
  onFiles(listener: (paths: string[]) => void): () => void;
  /** Output and state changes from workspace terminal processes. */
  onTerminal(listener: (event: TerminalEvent) => void): () => void;
  /** Direct Agent Chat progress pushed by the main process. Returns an unsubscribe function. */
  onAgentChat(listener: (push: Extract<HivePush, { kind: 'agentChat' }>) => void): () => void;
  /** Opens the Direct Agent Chat with this agent, in the project in front. */
  openAgentChat(workerId: string): void;
  pickWorkspace(): Promise<void>;
  /** Brings an open project to the front, as its tab would. */
  openWorkspace(workspace: Workspace): Promise<void>;
}

export const Hive = createContext<HiveContext | null>(null);

export function useHive(): HiveContext {
  const value = useContext(Hive);
  if (!value) throw new Error('useHive must be used inside <Hive.Provider>.');
  return value;
}

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Providers that can actually be called: a stored key, or one that works without (local, free). */
export const hasAccess = (provider: ProviderConfig) =>
  provider.enabled && (provider.hasCredential || !!providerPresets[provider.kind].keyOptional);

/** Agents that can answer now: a model, and a provider the user can reach. */
export const usableWorkers = (workers: Worker[], providers: ProviderConfig[]) =>
  workers.filter(
    (worker) =>
      worker.providerId &&
      worker.modelId &&
      providers.some((provider) => provider.id === worker.providerId && hasAccess(provider)),
  );
