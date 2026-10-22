import { describe, expect, it } from 'vitest';
import { HiveError } from '@hive/shared';
import { ProviderError, parseRetryAfter, retryDelay, withRetries } from './retry';

describe('retryDelay', () => {
  it('espera passar limites de uso, falhas do servidor e quedas de rede', () => {
    expect(retryDelay(new ProviderError('x', 429), 0)).toBe(15_000);
    expect(retryDelay(new ProviderError('x', 503), 1)).toBe(30_000);
    expect(retryDelay(new ProviderError('x', null), 9)).toBe(120_000);
    expect(retryDelay(new ProviderError('x', 429, 4_000), 3)).toBe(4_000);
    expect(retryDelay(new HiveError('TIMEOUT', 'x'), 0)).toBe(15_000);
  });

  it('não insiste em erros que uma nova tentativa não resolve', () => {
    expect(retryDelay(new ProviderError('x', 400), 0)).toBeNull();
    expect(retryDelay(new ProviderError('x', 401), 0)).toBeNull();
    expect(retryDelay(new HiveError('CANCELLED', 'x'), 0)).toBeNull();
    expect(retryDelay(new Error('x'), 0)).toBeNull();
  });
});

describe('parseRetryAfter', () => {
  it('lê segundos e datas, com um teto', () => {
    expect(parseRetryAfter('20')).toBe(20_000);
    expect(parseRetryAfter(new Date(61_000).toUTCString(), 1_000)).toBe(60_000);
    expect(parseRetryAfter('999999')).toBe(15 * 60_000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('amanhã')).toBeNull();
  });
});

describe('withRetries', () => {
  it('tenta de novo até dar certo e avisa cada espera', async () => {
    let calls = 0;
    const notices: number[] = [];
    const value = await withRetries(
      async () => {
        calls++;
        if (calls < 3) throw new ProviderError('limite', 429, 1);
        return 'ok';
      },
      { onRetry: (notice) => notices.push(notice.attempt) },
    );
    expect(value).toBe('ok');
    expect(notices).toEqual([2, 3]);
  });

  it('desiste em erros definitivos e no limite de tentativas', async () => {
    let calls = 0;
    const auth = withRetries(async () => {
      calls++;
      throw new ProviderError('chave', 401);
    });
    await expect(auth).rejects.toThrow('chave');
    expect(calls).toBe(1);

    calls = 0;
    const limited = withRetries(
      async () => {
        calls++;
        throw new ProviderError('limite', 429, 1);
      },
      { maxAttempts: 3 },
    );
    await expect(limited).rejects.toThrow('limite');
    expect(calls).toBe(3);
  });

  it('para de esperar quando a tarefa é cancelada', async () => {
    const controller = new AbortController();
    const pending = withRetries(
      async () => {
        throw new ProviderError('limite', 429, 60_000);
      },
      { signal: controller.signal, onRetry: () => controller.abort() },
    );
    await expect(pending).rejects.toThrow();
  });
});
