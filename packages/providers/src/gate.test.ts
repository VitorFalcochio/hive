import { describe, expect, it } from 'vitest';
import { ProviderGate } from './gate';
import { ProviderError, withRetries } from './retry';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('ProviderGate', () => {
  it('deixa passar poucos pedidos por vez e enfileira o resto', async () => {
    const gate = new ProviderGate(2);
    let running = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const call = () =>
      gate.run(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => releases.push(resolve));
        running--;
      });
    const calls = [call(), call(), call(), call(), call()];
    await tick();
    expect(running).toBe(2);
    while (releases.length) {
      releases.shift()!();
      await tick();
    }
    await Promise.all(calls);
    expect(peak).toBe(2);
  });

  it('um 429 pausa o provedor para todos e corta a vazão pela metade', async () => {
    const gate = new ProviderGate(4);
    await expect(
      gate.run(async () => {
        throw new ProviderError('limite', 429, 60);
      }),
    ).rejects.toThrow('limite');
    expect(gate.capacity).toBe(2);

    const started = Date.now();
    await gate.run(async () => 'ok');
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it('volta a crescer depois de uma sequência de sucessos', async () => {
    const gate = new ProviderGate(4);
    await gate.run(() => Promise.reject(new ProviderError('limite', 429, 1))).catch(() => {});
    expect(gate.capacity).toBe(2);
    for (let index = 0; index < 8; index++) await gate.run(async () => 'ok');
    expect(gate.capacity).toBe(3);
  });

  it('desiste da fila quando a tarefa é cancelada', async () => {
    const gate = new ProviderGate(1);
    let release = () => {};
    const busy = gate.run(() => new Promise<void>((resolve) => (release = resolve)));
    const controller = new AbortController();
    const waiting = gate.run(async () => 'nunca', controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow();
    release();
    await busy;
  });
});

describe('espera entre tentativas', () => {
  it('espalha as esperas para as abelhas não voltarem todas juntas', async () => {
    const delays: number[] = [];
    for (const random of [0, 1])
      await withRetries(
        (() => {
          let calls = 0;
          return async () => {
            if (calls++ === 0) throw new ProviderError('limite', 429, 10);
            return 'ok';
          };
        })(),
        { random: () => random, onRetry: (notice) => delays.push(notice.delayMs) },
      ).catch(() => {});
    // A wait the provider asked for is only lengthened, never shortened.
    expect(delays).toEqual([10, 13]);
  });
});
