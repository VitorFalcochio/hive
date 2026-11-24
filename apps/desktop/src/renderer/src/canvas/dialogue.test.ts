import { describe, expect, it } from 'vitest';
import type { AgentEvent, Task } from '@hive/core';
import { buildDialogue } from './dialogue';

const task = (overrides: Partial<Task>): Task =>
  ({
    id: 'task',
    runId: 'run',
    key: 'k',
    title: 'Tarefa',
    description: 'd',
    workerId: null,
    dependsOn: [],
    acceptanceCriteria: ['Pronta'],
    status: 'pending',
    result: null,
    error: null,
    createdAt: '2026-11-24T10:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    ...overrides,
  }) as Task;

const event = (overrides: Partial<AgentEvent>): AgentEvent => ({
  id: 'e',
  ts: '2026-11-24T10:00:00.000Z',
  workspaceId: 'ws',
  runId: 'run',
  taskId: null,
  workerId: null,
  type: 'info',
  level: 'info',
  message: '',
  data: null,
  ...overrides,
});

describe('Diálogo da equipe', () => {
  it('conta a missão como conversa: a Queen entrega, cada agente começa com o que recebeu e passa adiante', () => {
    const contract = task({
      id: 't1',
      key: 'contract',
      title: 'Contrato',
      workerId: 'back',
      status: 'completed',
      startedAt: '2026-11-24T10:01:00.000Z',
      finishedAt: '2026-11-24T10:05:00.000Z',
      result: { summary: 'Tipos e canais IPC em src/shared/contracts.ts.' } as Task['result'],
    });
    const ui = task({
      id: 't2',
      key: 'ui',
      title: 'Interface',
      workerId: 'front',
      dependsOn: ['contract'],
      status: 'failed',
      startedAt: '2026-11-24T10:06:00.000Z',
      finishedAt: '2026-11-24T10:09:00.000Z',
      error: 'Provider error 413.',
    });
    const integrate = task({
      id: 't3',
      key: 'integrate',
      title: 'Integrar',
      workerId: 'back',
      dependsOn: ['ui'],
    });
    const messages = buildDialogue({
      tasks: [contract, ui, integrate],
      events: [],
      queenWorkerId: 'queen',
    });
    const said = messages.map((m) => [m.kind, m.from, m.to, m.text]);
    expect(said).toContainEqual([
      'assign',
      'queen',
      ['front'],
      '“Interface”. Pronto quando: Pronta',
    ]);
    expect(said).toContainEqual([
      'start',
      'front',
      ['back'],
      'Começando “Interface” com o que recebi de “Contrato”.',
    ]);
    expect(said).toContainEqual([
      'deliver',
      'back',
      ['front'],
      'Entreguei “Contrato”: Tipos e canais IPC em src/shared/contracts.ts.',
    ]);
    expect(said).toContainEqual([
      'fail',
      'front',
      ['back'],
      'Não consegui terminar “Interface”: Provider error 413.',
    ]);
    // A task that has not started says nothing yet beyond being handed out.
    expect(messages.filter((m) => m.id.startsWith('t3:')).map((m) => m.kind)).toEqual(['assign']);
    // Oldest first.
    expect(messages.map((m) => m.at)).toEqual([...messages.map((m) => m.at)].sort());
  });

  it('inclui Hive Teams, a Verificação e o replanejamento, e ignora o resto do log', () => {
    const messages = buildDialogue({
      tasks: [task({ id: 't1', workerId: 'back', status: 'running' })],
      events: [
        event({ id: 'a', type: 'team', workerId: 'lead', message: 'Delegou “Tela” para Ana.' }),
        event({
          id: 'b',
          taskId: 't1',
          message: 'T1 voltou ao agente para corrigir "npm run build".',
          data: { source: 'flow' },
        }),
        event({
          id: 'c',
          type: 'plan',
          message: 'Replanejamento sugerido para “Tela”.',
          data: { source: 'nexus-autopilot-recovery' },
        }),
        event({ id: 'd', type: 'model.response', message: 'pensando…' }),
        event({ id: 'e', type: 'tool.call', message: 'read_file' }),
      ],
      queenWorkerId: 'queen',
    });
    const fromEvents = messages.filter((m) => ['a', 'b', 'c', 'd', 'e'].includes(m.id));
    expect(fromEvents.map((m) => [m.kind, m.from, m.to])).toEqual([
      ['team', 'lead', []],
      ['flow', null, ['back']],
      ['replan', 'queen', []],
    ]);
  });

  it('as tentativas de uma tarefa não falam por si, e textos longos são cortados', () => {
    const messages = buildDialogue({
      tasks: [
        task({ id: 't1', workerId: 'back', startedAt: '2026-11-24T10:01:00.000Z' }),
        task({
          id: 't1-b',
          workerId: 'other',
          // An attempt of t1; only that the field is there matters here.
          candidateOf: { taskId: 't1' } as unknown as Task['candidateOf'],
          startedAt: '2026-11-24T10:01:00.000Z',
        }),
        task({
          id: 't2',
          key: 'long',
          workerId: 'back',
          status: 'completed',
          finishedAt: '2026-11-24T10:02:00.000Z',
          result: { summary: 'x'.repeat(5_000) } as Task['result'],
        }),
      ],
      events: [],
      queenWorkerId: 'queen',
    });
    expect(messages.some((m) => m.id.startsWith('t1-b'))).toBe(false);
    const long = messages.find((m) => m.id === 't2:deliver')!;
    expect(long.text.length).toBeLessThanOrEqual(600);
    expect(long.text.endsWith('…')).toBe(true);
  });
});
