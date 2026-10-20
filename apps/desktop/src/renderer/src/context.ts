import { createContext, useContext } from 'react';
import type {
  AgentEvent,
  AppInfo,
  DashboardSummary,
  ProviderConfig,
  RunDetail,
  SkillSummary,
  Task,
  Worker,
  Workspace,
} from '@hive/core';

export type View = 'overview' | 'mission' | 'agents' | 'providers' | 'skills' | 'about';

export type ModalState =
  | { kind: 'mission' }
  | { kind: 'provider' }
  | { kind: 'key'; provider: ProviderConfig }
  | { kind: 'team'; providerId?: string }
  | { kind: 'model'; worker: Worker }
  | { kind: 'diff'; task: Task }
  | { kind: 'activity'; task: Task };

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
  pickWorkspace(): Promise<void>;
}

export const Hive = createContext<HiveContext | null>(null);

export function useHive(): HiveContext {
  const value = useContext(Hive);
  if (!value) throw new Error('useHive must be used inside <Hive.Provider>.');
  return value;
}

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Providers that can actually be called: a stored key, or a local server that needs none. */
export const hasAccess = (provider: ProviderConfig) =>
  provider.enabled && (provider.hasCredential || provider.kind === 'openai-compatible');
