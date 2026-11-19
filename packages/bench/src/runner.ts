import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  NativeAgentRuntime,
  metricsTotals,
  type AgentOutcome,
  type RuntimeEvent,
} from '@hive/agents';
import {
  isSafeCommand,
  rolePresets,
  type ContextMetrics,
  type ExecutionLimits,
  type Worker,
} from '@hive/core';
import type { ChatClient } from '@hive/providers';
import { builtinSkill, parseSkillMarkdown, type ResolvedSkill } from '@hive/skills';
import type { BenchTask } from './tasks';
import { changedFiles, grade, prepareWorkdir } from './workspace';

/** Commands an unattended bench run may execute besides Hive's read-only list. */
const BENCH_COMMANDS = [
  'npm test',
  'npm test *',
  'npm run test',
  'npm run test *',
  'node --test',
  'node --test *',
];

export interface BenchResult {
  taskId: string;
  level: number;
  model: string;
  /** Hidden check passed. */
  passed: boolean;
  noRegressions: boolean;
  /** What the agent itself reported. */
  agentStatus: 'completed' | 'failed' | 'cancelled' | 'error';
  agentError: string | null;
  seconds: number;
  steps: number;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens served from the provider's cache; null when it never reported one. */
  cachedTokens: number | null;
  /** Characters the tools produced, and the characters of them that reached the prompt. */
  rawToolChars: number;
  sentToolChars: number;
  /** read_output calls: the agent went back for output it had not been shown. */
  recoveries: number;
  toolCalls: number;
  toolErrors: number;
  failedEdits: number;
  /** Retries announced after provider errors (429, timeouts, 5xx). */
  providerRetries: number;
  /** Time the agent was told to wait before retrying. */
  retryWaitSeconds: number;
  commandsDenied: number;
  filesChanged: string[];
  summary: string;
  gradeOutput: string;
  /** By agent, model and tool. Absent in results from before Hive measured them. */
  metrics?: ContextMetrics;
}

export interface RunTaskOptions {
  task: BenchTask;
  model: string;
  chat: ChatClient;
  limits: ExecutionLimits;
  keepWorkdir?: boolean;
  onEvent?: (event: RuntimeEvent) => void;
}

function benchSkills(names: string[]): ResolvedSkill[] {
  return names.flatMap((name) => {
    const skill = builtinSkill(name);
    if (!skill) return [];
    const parsed = parseSkillMarkdown(skill.raw);
    return [
      {
        name,
        description: parsed.metadata.description,
        body: parsed.body.trim(),
        directory: '',
        source: 'local' as const,
        resources: [],
      },
    ];
  });
}

/** The agent the bench measures: Hive's stock Backend Developer on the given model. */
export function benchWorker(model: string, limits: ExecutionLimits): Worker {
  const preset = rolePresets.backend;
  const now = new Date().toISOString();
  return {
    id: 'bench-worker',
    name: 'Bench Developer',
    role: 'backend',
    beeColor: null,
    squad: [],
    description: preset.description,
    providerId: 'bench',
    modelId: model,
    skills: preset.skills,
    tools: preset.tools,
    mcpServers: [],
    autoApproveCommands: [],
    systemPrompt: preset.systemPrompt,
    limits,
    createdAt: now,
    updatedAt: now,
  };
}

export async function runTask(options: RunTaskOptions): Promise<BenchResult> {
  const { task, model, chat, limits } = options;
  const dir = await prepareWorkdir(task.id);
  const worker = benchWorker(model, limits);
  const runtime = new NativeAgentRuntime();
  const counters = {
    modelCalls: 0,
    toolCalls: 0,
    toolErrors: 0,
    failedEdits: 0,
    providerRetries: 0,
    retryWaitMs: 0,
    commandsDenied: 0,
  };
  const onEvent = (event: RuntimeEvent) => {
    options.onEvent?.(event);
    const data = event.data ?? {};
    if (event.type === 'model.response') counters.modelCalls++;
    if (event.type === 'tool.call') counters.toolCalls++;
    if (event.type === 'tool.result' && data.isError === true) {
      counters.toolErrors++;
      if (/old_string was not found/.test(event.message)) counters.failedEdits++;
    }
    if (typeof data.delayMs === 'number') {
      counters.providerRetries++;
      counters.retryWaitMs += data.delayMs;
    }
  };
  const started = Date.now();
  const sessionId = `bench-${randomUUID()}`;
  let outcome: AgentOutcome | null = null;
  let startError: string | null = null;
  try {
    const session = await runtime.start({
      sessionId,
      task: {
        title: task.title,
        description: task.description,
        acceptanceCriteria: task.acceptanceCriteria,
        upstream: [],
      },
      worker,
      model,
      chat,
      worktreePath: dir,
      skills: benchSkills(worker.skills),
      limits,
      requestApproval: async ({ command }) => {
        const allowed = isSafeCommand(command, BENCH_COMMANDS);
        if (!allowed) counters.commandsDenied++;
        return allowed;
      },
    });
    const unsubscribe = runtime.subscribe(sessionId, onEvent);
    outcome = await session.done;
    unsubscribe();
  } catch (error) {
    startError = error instanceof Error ? error.message : String(error);
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  const measured = outcome?.metrics ? metricsTotals([outcome.metrics]) : null;
  const files = await changedFiles(dir);
  const graded = await grade(task.id, dir);
  if (!options.keepWorkdir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  return {
    taskId: task.id,
    level: task.level,
    model,
    passed: graded.passed,
    noRegressions: graded.noRegressions,
    agentStatus: outcome?.status ?? 'error',
    agentError: outcome ? outcome.error : (startError ?? 'unknown'),
    seconds,
    steps: outcome?.steps ?? 0,
    modelCalls: counters.modelCalls,
    promptTokens: outcome?.usage.promptTokens ?? 0,
    completionTokens: outcome?.usage.completionTokens ?? 0,
    cachedTokens: measured?.cachedTokens ?? null,
    rawToolChars: measured?.rawToolChars ?? 0,
    sentToolChars: measured?.sentToolChars ?? 0,
    recoveries: measured?.recoveries ?? 0,
    toolCalls: counters.toolCalls,
    toolErrors: counters.toolErrors,
    failedEdits: counters.failedEdits,
    providerRetries: counters.providerRetries,
    retryWaitSeconds: Math.round(counters.retryWaitMs / 1000),
    commandsDenied: counters.commandsDenied,
    filesChanged: files,
    summary: (outcome?.summary ?? '').slice(0, 1_500),
    gradeOutput: graded.passed && graded.noRegressions ? '' : graded.output,
    ...(outcome?.metrics ? { metrics: outcome.metrics } : {}),
  };
}
