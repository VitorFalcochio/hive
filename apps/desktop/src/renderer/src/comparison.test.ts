import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task, Worker } from '@hive/core';
import {
  applyCandidate,
  buildComparisonPlan,
  discardCandidates,
  isCandidate,
  summarizeCandidate,
} from './comparison';

const worker = (id: string, name: string) => ({ id, name }) as Worker;

const candidate = (id: string, status: Task['status'], key = `candidate-${id}`) =>
  ({ id, key, status, result: null }) as unknown as Task;

const calls: [string, string][] = [];
const invoke = vi.fn(async (channel: string, input: string) => {
  calls.push([channel, input]);
});

beforeEach(() => {
  calls.length = 0;
  invoke.mockClear();
  Object.defineProperty(globalThis, 'window', { value: { hive: { invoke } }, configurable: true });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window');
});

describe('buildComparisonPlan', () => {
  it('creates one independent task per agent with the same objective', () => {
    const plan = buildComparisonPlan('  Criar a pÃ¡gina de contato  ', [
      worker('w1', 'Ana'),
      worker('w2', 'Bruno'),
    ]);
    expect(plan.tasks.map((task) => task.key)).toEqual(['candidate-1', 'candidate-2']);
    expect(plan.tasks.map((task) => task.workerId)).toEqual(['w1', 'w2']);
    expect(plan.tasks.every((task) => task.dependsOn.length === 0)).toBe(true);
    expect(plan.tasks[0]!.description).toBe('Criar a pÃ¡gina de contato');
    expect(plan.tasks[1]!.title).toBe('Candidato: Bruno');
  });

  it('needs at least two agents and at most six', () => {
    expect(() => buildComparisonPlan('x', [worker('w1', 'Ana')])).toThrow('de 2 a 6');
    const seven = Array.from({ length: 7 }, (_, index) => worker(`w${index}`, `A${index}`));
    expect(() => buildComparisonPlan('x', seven)).toThrow('de 2 a 6');
  });

  it('refuses objectives too long for a task description', () => {
    const long = 'x'.repeat(4_001);
    expect(() => buildComparisonPlan(long, [worker('w1', 'Ana'), worker('w2', 'Bruno')])).toThrow(
      '4.000 caracteres',
    );
  });
});

describe('isCandidate', () => {
  it('recognises tasks created by a comparison', () => {
    expect(isCandidate({ key: 'candidate-1' })).toBe(true);
    expect(isCandidate({ key: 'setup-db' })).toBe(false);
  });
});

describe('applyCandidate', () => {
  it('approves the chosen candidate and discards the finished ones', async () => {
    const chosen = candidate('a', 'completed');
    const done = candidate('b', 'completed');
    const running = candidate('c', 'running');
    await applyCandidate(chosen, [chosen, done, running]);
    expect(calls).toEqual([
      ['task.approve', 'a'],
      ['task.reject', 'b'],
      ['task.cancel', 'c'],
    ]);
  });

  it('leaves the others alone when the chosen candidate cannot be applied', async () => {
    invoke.mockImplementationOnce(async (channel: string, input: string) => {
      calls.push([channel, input]);
      throw new Error('Conflito');
    });
    const chosen = candidate('a', 'completed');
    await expect(applyCandidate(chosen, [chosen, candidate('b', 'completed')])).rejects.toThrow(
      'Conflito',
    );
    expect(calls).toEqual([['task.approve', 'a']]);
  });
});

describe('discardCandidates', () => {
  it('skips candidates already applied or rejected', async () => {
    await discardCandidates([
      candidate('a', 'approved'),
      candidate('b', 'rejected'),
      candidate('c', 'completed'),
      candidate('d', 'failed'),
    ]);
    expect(calls).toEqual([['task.reject', 'c']]);
  });
});

describe('summarizeCandidate', () => {
  it('counts passing commands and reports nothing before a result exists', () => {
    expect(summarizeCandidate(candidate('a', 'running'))).toBeNull();
    const withResult = {
      ...candidate('a', 'completed'),
      result: {
        filesChanged: [{ path: 'a.ts', status: 'M' }],
        insertions: 4,
        deletions: 1,
        commands: [
          { command: 'npm test', exitCode: 0, timedOut: false },
          { command: 'npm run lint', exitCode: 1, timedOut: false },
          { command: 'npm run build', exitCode: 0, timedOut: true },
        ],
      },
    } as unknown as Task;
    expect(summarizeCandidate(withResult)).toEqual({
      filesChanged: 1,
      insertions: 4,
      deletions: 1,
      commandsPassed: 1,
      commandsRun: 3,
    });
  });
});
