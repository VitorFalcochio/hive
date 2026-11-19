import { describe, expect, it } from 'vitest';
import { contextMetricsSchema, taskResultSchema } from '@hive/core';
import { CAPTAIN, ContextLedger, metricsTotals } from './ledger';

describe('ContextLedger', () => {
  it('counts model calls by agent and model, keeping an unreported cache unknown', () => {
    const ledger = new ContextLedger();
    ledger.modelCall(CAPTAIN, 'grande', { promptTokens: 100, completionTokens: 10 }, 50);
    ledger.modelCall(CAPTAIN, 'grande', null, 20);
    ledger.modelCall(
      'scout',
      'pequeno',
      { promptTokens: 40, completionTokens: 4, cachedTokens: 0 },
      5,
    );
    ledger.modelCall(
      'scout',
      'pequeno',
      { promptTokens: 40, completionTokens: 4, cachedTokens: 30 },
      5,
    );

    const { models } = ledger.snapshot();
    expect(models).toEqual([
      {
        agent: 'captain',
        model: 'grande',
        calls: 2,
        promptTokens: 100,
        completionTokens: 10,
        cachedTokens: null,
        latencyMs: 70,
      },
      {
        agent: 'scout',
        model: 'pequeno',
        calls: 2,
        promptTokens: 80,
        completionTokens: 8,
        cachedTokens: 30,
        latencyMs: 10,
      },
    ]);
  });

  it('counts tool calls with the characters produced and the characters sent', () => {
    const ledger = new ContextLedger();
    ledger.toolCall(CAPTAIN, 'run_command', { output: 'curto', isError: false });
    ledger.toolCall(CAPTAIN, 'run_command', {
      output: 'x'.repeat(10),
      isError: true,
      rawChars: 500,
    });
    ledger.toolCall('scout', 'read_file', { output: 'abc', isError: false });

    const { tools } = ledger.snapshot();
    expect(tools).toEqual([
      {
        agent: 'captain',
        tool: 'run_command',
        calls: 2,
        errors: 1,
        rawChars: 505,
        sentChars: 15,
        shortened: 1,
      },
      {
        agent: 'scout',
        tool: 'read_file',
        calls: 1,
        errors: 0,
        rawChars: 3,
        sentChars: 3,
        shortened: 0,
      },
    ]);
  });

  it('gives a snapshot that matches the stored schema and does not change afterwards', () => {
    const ledger = new ContextLedger('legacy');
    ledger.modelCall(CAPTAIN, 'm', { promptTokens: 1, completionTokens: 1 }, 1);
    ledger.toolCall(CAPTAIN, 'search', { output: 'a', isError: false });
    ledger.compacted(1_100);
    ledger.recovered();
    ledger.loopWarned();
    const snapshot = ledger.snapshot();
    ledger.modelCall(CAPTAIN, 'm', { promptTokens: 1, completionTokens: 1 }, 1);
    ledger.toolCall(CAPTAIN, 'search', { output: 'a', isError: false });

    expect(contextMetricsSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.models[0]!.calls).toBe(1);
    expect(snapshot.tools[0]!.calls).toBe(1);
    expect(snapshot).toMatchObject({
      version: 1,
      mode: 'legacy',
      compaction: { outputs: 1, charsRemoved: 1_100 },
      recoveries: 1,
      loopWarnings: 1,
    });
  });

  it('sums sessions, and the cache stays unknown only when no call reported it', () => {
    const a = new ContextLedger();
    a.modelCall(CAPTAIN, 'm', { promptTokens: 10, completionTokens: 1 }, 1);
    a.toolCall(CAPTAIN, 'run_command', { output: 'ab', isError: true, rawChars: 9 });
    const b = new ContextLedger();
    b.modelCall(CAPTAIN, 'm', { promptTokens: 20, completionTokens: 2, cachedTokens: 5 }, 1);
    b.recovered();

    expect(metricsTotals([a.snapshot()]).cachedTokens).toBeNull();
    expect(metricsTotals([a.snapshot(), b.snapshot()])).toEqual({
      modelCalls: 2,
      promptTokens: 30,
      completionTokens: 3,
      cachedTokens: 5,
      toolCalls: 1,
      toolErrors: 1,
      rawToolChars: 9,
      sentToolChars: 2,
      compactedChars: 0,
      recoveries: 1,
      loopWarnings: 0,
    });
  });
});

describe('task results', () => {
  const result = {
    summary: 'ok',
    filesChanged: [],
    insertions: 0,
    deletions: 0,
    commit: null,
    commands: [],
    usage: { promptTokens: 1, completionTokens: 1 },
  };

  it('still accepts results saved before metrics existed', () => {
    expect(taskResultSchema.parse(result)).toEqual(result);
  });

  it('keeps the metrics of new results', () => {
    const metrics = new ContextLedger().snapshot();
    expect(taskResultSchema.parse({ ...result, metrics }).metrics).toEqual(metrics);
  });
});
