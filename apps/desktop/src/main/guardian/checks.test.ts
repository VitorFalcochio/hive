import { describe, expect, it } from 'vitest';
import type { AgentEvent, Task } from '@hive/core';
import {
  LOOP_REPEATS,
  SILENT_FAIL_MS,
  SILENT_WARN_MS,
  checkAgents,
  checkFailedTasks,
  checkProviders,
  checkRenderer,
  checkResources,
} from './checks';

const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const task = (overrides: Partial<Task>): Task =>
  ({
    id: 't1',
    runId: 'r1',
    key: 't1',
    title: 'Tela',
    workerId: 'w1',
    status: 'running',
    workerState: 'thinking',
    startedAt: ago(60 * 60_000),
    finishedAt: null,
    error: null,
    ...overrides,
  }) as Task;

const event = (overrides: Partial<AgentEvent>): AgentEvent => ({
  id: Math.random().toString(36),
  ts: ago(1_000),
  workspaceId: 'ws',
  runId: 'r1',
  taskId: 't1',
  workerId: 'w1',
  type: 'model.response',
  level: 'info',
  message: 'ok',
  data: null,
  ...overrides,
});

const workers = new Map([['w1', { name: 'Ana' }]]);

describe('agentes: sinal de vida e loops', () => {
  it('quem fala recentemente está bem; calado há muito tempo vira alerta e depois falha', () => {
    const check = (silent: number) =>
      checkAgents({
        now: NOW,
        tasks: [task({})],
        workers,
        recent: new Map([['t1', [event({ ts: ago(silent) })]]]),
      });
    expect(check(60_000).status).toBe('ok');
    const quiet = check(SILENT_WARN_MS + 1_000);
    expect(quiet.status).toBe('warn');
    expect(quiet.incidents[0]).toMatchObject({
      key: 'silent:t1',
      severity: 'warning',
      action: 'cancel-task',
      taskId: 't1',
    });
    expect(check(SILENT_FAIL_MS + 1_000).incidents[0]!.severity).toBe('critical');
  });

  it('esperar a aprovação do usuário não é travar', () => {
    const outcome = checkAgents({
      now: NOW,
      tasks: [task({ status: 'waiting_approval' })],
      workers,
      recent: new Map([['t1', [event({ ts: ago(SILENT_FAIL_MS * 2) })]]]),
    });
    expect(outcome.status).toBe('ok');
    expect(outcome.agents[0]!.state).toBe('Aguardando sua aprovação');
  });

  it('a mesma chamada de ferramenta repetida é um loop improdutivo', () => {
    const calls = Array.from({ length: LOOP_REPEATS }, () =>
      event({ type: 'tool.call', message: 'read_file src/a.ts' }),
    );
    const outcome = checkAgents({
      now: NOW,
      tasks: [task({})],
      workers,
      recent: new Map([['t1', calls]]),
    });
    expect(outcome.incidents.map((item) => item.key)).toContain('loop:t1');
    // Different calls are progress, not a loop.
    const varied = calls.map((item, index) => ({ ...item, message: `read_file ${index}` }));
    expect(
      checkAgents({ now: NOW, tasks: [task({})], workers, recent: new Map([['t1', varied]]) })
        .incidents,
    ).toEqual([]);
  });
});

describe('provedores, interface, recursos e tarefas', () => {
  it('modelos descansando e rajadas de erro de provedor', () => {
    const errors = Array.from({ length: 6 }, () =>
      event({ level: 'warn', message: 'Provider error 413. Request too large' }),
    );
    const outcome = checkProviders({
      now: NOW,
      resting: [{ key: 'groq\u0000gpt-oss', untilMs: 5 * 60_000 }],
      events: [...errors, event({ level: 'warn', message: 'outra coisa' })],
    });
    expect(outcome.status).toBe('warn');
    expect(outcome.incidents.map((item) => item.key)).toEqual([
      'providers:resting',
      'providers:errors',
    ]);
    expect(outcome.incidents[0]!.detail).toContain('groq/gpt-oss');
    // Old errors do not count.
    expect(
      checkProviders({
        now: NOW,
        resting: [],
        events: errors.map((item) => ({ ...item, ts: ago(60 * 60_000) })),
      }).status,
    ).toBe('ok');
  });

  it('janela congelada é falha; quando volta a responder, deixa de ser', () => {
    const frozen = { at: ago(30_000), level: 'warn', text: 'Hive: a interface não responde.' };
    expect(checkRenderer({ now: NOW, lines: [frozen] }).status).toBe('fail');
    const back = { at: ago(10_000), level: 'info', text: 'Hive: voltou a responder.' };
    expect(checkRenderer({ now: NOW, lines: [frozen, back] }).status).toBe('ok');
  });

  it('pouca memória ou disco viram incidentes', () => {
    const outcome = checkResources({
      cpuPercent: 12,
      memoryMb: 900,
      processes: [],
      systemFreeMb: 200,
      systemTotalMb: 16_000,
      diskFreeMb: 300,
    });
    expect(outcome.status).toBe('fail');
    expect(outcome.incidents.map((item) => item.key)).toEqual([
      'resources:memory',
      'resources:disk',
    ]);
  });

  it('tarefas que falharam no último dia oferecem repetir', () => {
    const outcome = checkFailedTasks(
      [
        task({ id: 'a', status: 'failed', finishedAt: ago(60_000), error: 'Provider error 400' }),
        task({ id: 'b', status: 'failed', finishedAt: ago(3 * 24 * 60 * 60_000) }),
      ],
      NOW,
    );
    expect(outcome.incidents).toEqual([
      expect.objectContaining({ key: 'failed:a', action: 'retry-task', taskId: 'a' }),
    ]);
  });
});
