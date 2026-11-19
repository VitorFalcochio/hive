import type { ContextMetrics, ContextMode, ModelMetrics, ToolMetrics } from '@hive/core';
import type { ChatUsage } from '@hive/providers';

/** The agent of a session that the captain's own loop is counted under. */
export const CAPTAIN = 'captain';

/**
 * What one agent session spends, counted as it happens: model calls by agent (the captain or
 * a soldier role) and model, tool calls by agent and tool with the characters each produced
 * and the characters that reached the prompt. It holds numbers only, never content, so its
 * snapshot is safe to log and to keep with the task result.
 */
export class ContextLedger {
  private readonly models = new Map<string, ModelMetrics>();
  private readonly tools = new Map<string, ToolMetrics>();
  private readonly compaction = { outputs: 0, charsRemoved: 0 };
  private recoveries = 0;
  private loopWarnings = 0;

  constructor(private readonly mode: ContextMode = 'legacy') {}

  modelCall(agent: string, model: string, usage: ChatUsage | null, latencyMs: number): void {
    const key = `${agent}\u0000${model}`;
    const entry = this.models.get(key) ?? {
      agent,
      model,
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: null,
      latencyMs: 0,
    };
    entry.calls++;
    entry.latencyMs += Math.max(0, latencyMs);
    if (usage) {
      entry.promptTokens += usage.promptTokens;
      entry.completionTokens += usage.completionTokens;
      // Unknown stays unknown: a provider that never reports a cache is not a 0% hit rate.
      if (typeof usage.cachedTokens === 'number')
        entry.cachedTokens = (entry.cachedTokens ?? 0) + usage.cachedTokens;
    }
    this.models.set(key, entry);
  }

  /**
   * One tool call. `rawChars` is the size of what the tool produced before Hive shortened it;
   * when the tool did not say, the output was sent as produced.
   */
  toolCall(
    agent: string,
    tool: string,
    result: { output: string; isError: boolean; rawChars?: number },
  ): void {
    const key = `${agent}\u0000${tool}`;
    const entry = this.tools.get(key) ?? {
      agent,
      tool,
      calls: 0,
      errors: 0,
      rawChars: 0,
      sentChars: 0,
      shortened: 0,
    };
    const sent = result.output.length;
    const raw = Math.max(result.rawChars ?? sent, 0);
    entry.calls++;
    if (result.isError) entry.errors++;
    entry.rawChars += raw;
    entry.sentChars += sent;
    if (sent < raw) entry.shortened++;
    this.tools.set(key, entry);
  }

  compacted(charsRemoved: number): void {
    this.compaction.outputs++;
    this.compaction.charsRemoved += Math.max(0, charsRemoved);
  }

  recovered(): void {
    this.recoveries++;
  }

  loopWarned(): void {
    this.loopWarnings++;
  }

  snapshot(): ContextMetrics {
    return {
      version: 1,
      mode: this.mode,
      models: [...this.models.values()].map((entry) => ({ ...entry })),
      tools: [...this.tools.values()].map((entry) => ({ ...entry })),
      compaction: { ...this.compaction },
      recoveries: this.recoveries,
      loopWarnings: this.loopWarnings,
    };
  }
}

/** Totals over every agent and model of a set of metrics, for reports. */
export function metricsTotals(metrics: ContextMetrics[]): {
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  /** Null when no call of any of them reported a cache. */
  cachedTokens: number | null;
  toolCalls: number;
  toolErrors: number;
  rawToolChars: number;
  sentToolChars: number;
  compactedChars: number;
  recoveries: number;
  loopWarnings: number;
} {
  let cached: number | null = null;
  const totals = {
    modelCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    toolCalls: 0,
    toolErrors: 0,
    rawToolChars: 0,
    sentToolChars: 0,
    compactedChars: 0,
    recoveries: 0,
    loopWarnings: 0,
  };
  for (const item of metrics) {
    for (const model of item.models) {
      totals.modelCalls += model.calls;
      totals.promptTokens += model.promptTokens;
      totals.completionTokens += model.completionTokens;
      if (model.cachedTokens !== null) cached = (cached ?? 0) + model.cachedTokens;
    }
    for (const tool of item.tools) {
      totals.toolCalls += tool.calls;
      totals.toolErrors += tool.errors;
      totals.rawToolChars += tool.rawChars;
      totals.sentToolChars += tool.sentChars;
    }
    totals.compactedChars += item.compaction.charsRemoved;
    totals.recoveries += item.recoveries;
    totals.loopWarnings += item.loopWarnings;
  }
  return { ...totals, cachedTokens: cached };
}
