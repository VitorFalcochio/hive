import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@hive/core';
import {
  MAX_CELLS,
  emptyComb,
  honeyLevel,
  pruneBees,
  reduceComb,
  spiral,
  type CombState,
} from './colmeia-model';

let seq = 0;
function event(patch: Partial<AgentEvent> & Pick<AgentEvent, 'type'>): AgentEvent {
  seq++;
  return {
    id: `e${seq}`,
    ts: new Date(Date.UTC(2026, 9, 26, 12, 0, seq)).toISOString(),
    workspaceId: 'ws',
    runId: 'r1',
    taskId: 't1',
    workerId: 'w1',
    level: 'info',
    message: '',
    data: null,
    ...patch,
  };
}

const fold = (events: AgentEvent[], start: CombState = emptyComb) =>
  events.reduce(reduceComb, start);

describe('favo da Colmeia', () => {
  it('leva a abelha ao arquivo que ela lê e enche de mel o que ela edita', () => {
    const comb = fold([
      event({ type: 'tool.call', data: { tool: 'read_file', args: { path: './src/app.ts' } } }),
      event({ type: 'tool.call', data: { tool: 'replace_in_file', args: { path: 'src/db.ts' } } }),
      event({ type: 'file.changed', data: { path: 'src/db.ts', action: 'modified' } }),
    ]);
    expect(comb.order).toEqual(['src/app.ts', 'src/db.ts']);
    expect(comb.cells['src/app.ts']).toMatchObject({ slot: 0, reads: 1, writes: 0 });
    expect(comb.cells['src/db.ts']).toMatchObject({ slot: 1, writes: 1, taskId: 't1' });
    expect(comb.bees.t1).toMatchObject({ target: 'src/db.ts', doing: 'Editando src/db.ts' });
    expect(comb.feed[0]!).toMatchObject({ workerId: 'w1' });
    expect(comb.feed[0]!.text).toBe('editou src/db.ts');
  });

  it('separa a soldada da capitã e a dispensa quando ela volta', () => {
    const soldier = { soldier: 'scout' };
    let comb = fold([
      event({ type: 'info', data: { ...soldier, phase: 'start' } }),
      event({ type: 'tool.call', data: { ...soldier, tool: 'read_file', args: { path: 'a.ts' } } }),
    ]);
    expect(comb.bees['t1/scout']).toMatchObject({
      captain: 't1',
      soldier: 'scout',
      target: 'a.ts',
    });
    comb = reduceComb(comb, event({ type: 'info', data: { ...soldier, phase: 'end' } }));
    expect(pruneBees(comb, new Set(['t1'])).bees['t1/scout']).toBeUndefined();
  });

  it('acompanha as abelhas do terminal pela conversa', () => {
    const comb = fold([
      event({
        type: 'worker.state',
        taskId: null,
        runId: null,
        data: { state: 'waiting_approval', chat: 'chat-1', title: 'arrume o login' },
      }),
    ]);
    expect(comb.bees['chat-1']).toMatchObject({
      chatTitle: 'arrume o login',
      state: 'waiting_approval',
      doing: 'Esperando sua aprovação',
    });
    expect(pruneBees(comb, new Set()).bees).toEqual({});
  });

  it('marca comando que falhou e soma os tokens', () => {
    const comb = fold([
      event({ type: 'command.finished', data: { command: 'npm test', exitCode: 1 } }),
      event({
        type: 'model.response',
        data: { usage: { promptTokens: 900, completionTokens: 100 } },
      }),
    ]);
    expect(comb.bees.t1!.alert).toBe(true);
    expect(comb.feed[0]).toMatchObject({ text: '$ npm test · saiu com 1', tone: 'warn' });
    expect(comb.tokens).toBe(1_000);
  });

  it('ignora o que não é de uma tarefa nem de uma conversa', () => {
    const before = emptyComb;
    expect(reduceComb(before, event({ type: 'run.status', taskId: null }))).toBe(before);
  });

  it('para de crescer no limite, sem embaralhar o que já está no favo', () => {
    const events = Array.from({ length: MAX_CELLS + 5 }, (_, index) =>
      event({ type: 'tool.call', data: { tool: 'read_file', args: { path: `f${index}.ts` } } }),
    );
    const comb = fold(events);
    expect(comb.order).toHaveLength(MAX_CELLS);
    expect(comb.cells['f0.ts']!.slot).toBe(0);
  });
});

describe('geometria do favo', () => {
  it('gera uma espiral sem repetir células, anel por anel', () => {
    const cells = spiral(37);
    expect(new Set(cells.map(({ q, r }) => `${q},${r}`)).size).toBe(37);
    // Every cell of ring n is n steps from the centre.
    const distance = ({ q, r }: { q: number; r: number }) =>
      (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;
    expect(cells.slice(1, 7).every((cell) => distance(cell) === 1)).toBe(true);
    expect(cells.slice(7, 19).every((cell) => distance(cell) === 2)).toBe(true);
  });

  it('enche o favo aos poucos', () => {
    expect(honeyLevel({ writes: 0 })).toBe(0);
    expect(honeyLevel({ writes: 1 })).toBeCloseTo(0.4);
    expect(honeyLevel({ writes: 9 })).toBe(1);
  });
});
