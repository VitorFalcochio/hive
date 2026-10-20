import type { AgentEventType, CommandEvidence, ExecutionLimits, Worker } from '@hive/core';
import type { ChatClient } from '@hive/providers';
import type { ResolvedSkill } from '@hive/skills';

export interface AgentTaskInput {
  /** Caller-chosen id so events can be correlated before `start` resolves. */
  sessionId: string;
  task: {
    title: string;
    description: string;
    acceptanceCriteria: string[];
    /** Results of upstream tasks this one builds on. */
    upstream: { title: string; summary: string }[];
  };
  worker: Worker;
  model: string;
  chat: ChatClient;
  /** Absolute path of the isolated worktree. All file tools are confined to it. */
  worktreePath: string;
  skills: ResolvedSkill[];
  limits: ExecutionLimits;
  /** Asks the user whether a command may run. Resolves false when denied. */
  requestApproval: (request: { command: string }) => Promise<boolean>;
}

export interface RuntimeEvent {
  type: AgentEventType;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
}

export interface AgentOutcome {
  status: 'completed' | 'failed' | 'cancelled';
  summary: string;
  error: string | null;
  steps: number;
  usage: { promptTokens: number; completionTokens: number };
  commands: CommandEvidence[];
}

export interface AgentSession {
  id: string;
  /** Settles when the session ends; never rejects. */
  done: Promise<AgentOutcome>;
}

/**
 * The contract every agent engine implements. The built-in engine is NativeAgentRuntime;
 * other engines (e.g. an OpenCode server) can be added behind the same interface.
 */
export interface AgentRuntime {
  readonly id: string;
  start(input: AgentTaskInput): Promise<AgentSession>;
  cancel(sessionId: string): Promise<void>;
  subscribe(sessionId: string, onEvent: (event: RuntimeEvent) => void): () => void;
}
