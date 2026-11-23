import { describe, expect, it } from 'vitest';
import type { CandidateScore, Task } from '@hive/core';
import { candidateKey, failureSummary, pickWinner } from './candidates';

const candidate = (number: number, patch: Partial<Task> = {}): Task =>
  ({
    id: `c${number}`,
    status: 'completed',
    finishedAt: `2026-11-23T10:0${number}:00.000Z`,
    result: { commit: `commit${number}` },
    error: null,
    candidateOf: { parentTaskId: 'p', round: 1, number, providerId: 'p1', modelId: `m${number}` },
    ...patch,
  }) as Task;

const score = (number: number, oks: boolean[]): CandidateScore => ({
  taskId: `c${number}`,
  number,
  providerId: 'p1',
  modelId: `m${number}`,
  status: 'completed',
  checks: oks.map((ok, index) => ({ command: `check ${index}`, ok })),
});

describe('escolha entre as tentativas', () => {
  it('vence quem passa em mais verificações, mesmo terminando depois', () => {
    const { winner, reason } = pickWinner(
      [candidate(1), candidate(2), candidate(3, { status: 'failed', result: null })],
      [score(1, [true, false]), score(2, [true, true]), score(3, [])],
    );
    expect(winner?.id).toBe('c2');
    expect(reason).toContain('tentativa 2 (m2) passou em 2 de 2');
    expect(reason).toContain('tentativa 3 não terminou');
  });

  it('empate: quem alterou algo vence quem não alterou; depois, quem terminou primeiro', () => {
    const nothing = candidate(1, { result: { commit: null } as Task['result'] });
    expect(pickWinner([nothing, candidate(2)], []).winner?.id).toBe('c2');
    expect(pickWinner([candidate(3), candidate(2)], []).winner?.id).toBe('c2');
  });

  it('sem nenhuma concluída não há vencedora, e o resumo traz o erro de cada uma', () => {
    const failed = [
      candidate(1, { status: 'failed', error: 'limite do provedor' }),
      candidate(2, { status: 'cancelled', error: 'Cancelada.' }),
    ];
    expect(pickWinner(failed, []).winner).toBeNull();
    const summary = failureSummary(failed);
    expect(summary).toContain('Nenhuma das 2 tentativas deu certo');
    expect(summary).toContain('tentativa 1 (m1): limite do provedor');
  });

  it('a chave da tentativa serve de nome de branch', () => {
    expect(candidateKey('api-login', 2, 3)).toBe('api-login-r2t3');
  });
});
