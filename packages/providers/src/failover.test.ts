import { describe, expect, it, vi } from 'vitest';
import { HiveError } from '@hive/shared';
import { FailoverClient, RouteHealth, type ChatRoute, type RouteSwitch } from './failover';
import { ProviderError } from './retry';
import type { ChatClient, ChatRequest, ChatResponse } from './types';

const answer = (text: string): ChatResponse => ({
  message: { role: 'assistant', content: text },
  reasoning: null,
  finishReason: 'stop',
  usage: null,
  latencyMs: 1,
});

/** A provider whose next answers are scripted: a string answers, an Error fails. */
function provider(...script: (string | Error)[]) {
  const calls: ChatRequest[] = [];
  const client: ChatClient = {
    chat: vi.fn(async (request: ChatRequest) => {
      calls.push(request);
      const next = script.length > 1 ? script.shift()! : script[0]!;
      if (next instanceof Error) throw next;
      return answer(next);
    }),
  };
  return { client, calls };
}

const route = (providerId: string, model: string, client: ChatClient): ChatRoute => ({
  providerId,
  providerName: providerId.toUpperCase(),
  model,
  client,
});
const request: ChatRequest = {
  model: 'primary-model',
  messages: [{ role: 'user', content: 'oi' }],
};
const limited = () => new ProviderError('Rate limited (429).', 429, 30_000);

describe('troca automática de modelo', () => {
  it('um 429 passa na hora para o próximo provedor, com o modelo dele, sem esperar', async () => {
    const a = provider(limited());
    const b = provider('resposta de b');
    const switches: RouteSwitch[] = [];
    const client = new FailoverClient(
      () => [route('a', 'primary-model', a.client), route('b', 'b-model', b.client)],
      new RouteHealth(),
      (change) => switches.push(change),
    );
    const response = await client.chat(request);
    expect(response.message.content).toBe('resposta de b');
    expect(b.calls[0]?.model).toBe('b-model');
    expect(switches).toEqual([
      expect.objectContaining({ reason: 'limite de uso (429)', restored: false }),
    ]);
    expect(switches[0]?.from.providerId).toBe('a');
    expect(switches[0]?.to.providerId).toBe('b');
  });

  it('com o modelo principal saudável, a cadeia completa nem é montada', async () => {
    const a = provider('ok');
    const routes = vi.fn((full: boolean) =>
      full
        ? [route('a', 'primary-model', a.client), route('b', 'b-model', provider('b').client)]
        : [route('a', 'primary-model', a.client)],
    );
    await new FailoverClient(routes, new RouteHealth()).chat(request);
    expect(routes).not.toHaveBeenCalledWith(true);
  });

  it('outro agente pula o modelo esgotado sem gastar uma chamada', async () => {
    const health = new RouteHealth();
    const a = provider(limited());
    const b = provider('ok');
    const routes = () => [route('a', 'primary-model', a.client), route('b', 'b-model', b.client)];
    await new FailoverClient(routes, health).chat(request);
    await new FailoverClient(routes, health).chat(request);
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(2);
  });

  it('volta ao modelo principal assim que ele descansa', async () => {
    let now = 0;
    const health = new RouteHealth(() => now);
    const a = provider(limited(), 'a de volta');
    const b = provider('b');
    const switches: RouteSwitch[] = [];
    const client = new FailoverClient(
      () => [route('a', 'primary-model', a.client), route('b', 'b-model', b.client)],
      health,
      (change) => switches.push(change),
    );
    await client.chat(request);
    now = 31_000;
    const back = await client.chat(request);
    expect(back.message.content).toBe('a de volta');
    expect(a.calls[1]?.model).toBe('primary-model');
    expect(switches.at(-1)).toEqual(expect.objectContaining({ restored: true }));
  });

  it('com todos no limite, falha com 429 e diz quanto esperar', async () => {
    const client = new FailoverClient(
      () => [
        route('a', 'primary-model', provider(limited()).client),
        route('b', 'b-model', provider(new ProviderError('quota', 429, 10_000)).client),
      ],
      new RouteHealth(),
    );
    const failure = await client.chat(request).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).status).toBe(429);
    expect((failure as ProviderError).retryAfterMs).toBeGreaterThanOrEqual(9_000);
    expect((failure as ProviderError).retryAfterMs).toBeLessThanOrEqual(30_000);
  });

  it('cota diária, falta de créditos, modelo removido e chave recusada também trocam', async () => {
    for (const error of [
      new ProviderError('Rate limit exceeded: free-models-per-day', 429),
      new ProviderError('Insufficient credits', 402),
      new ProviderError('Not found (404)', 404),
      new HiveError('PROVIDER_AUTH', 'Authentication failed (401).'),
    ]) {
      const b = provider('ok');
      const client = new FailoverClient(
        () => [route('a', 'm', provider(error).client), route('b', 'n', b.client)],
        new RouteHealth(),
      );
      expect((await client.chat(request)).message.content).toBe('ok');
    }
  });

  it('um pedido inválido não é culpa do modelo: sobe sem trocar', async () => {
    const b = provider('ok');
    const client = new FailoverClient(
      () => [
        route('a', 'm', provider(new ProviderError('Bad request', 400)).client),
        route('b', 'n', b.client),
      ],
      new RouteHealth(),
    );
    await expect(client.chat(request)).rejects.toThrow('Bad request');
    expect(b.calls).toHaveLength(0);
  });

  it('com um único modelo, nada muda: o erro do provedor sobe como antes', async () => {
    const client = new FailoverClient(
      () => [route('a', 'm', provider(new ProviderError('Not found (404)', 404)).client)],
      new RouteHealth(),
    );
    await expect(client.chat(request)).rejects.toThrow('404');
    // Not left resting for hours: the next call goes to the provider again.
    await expect(client.chat(request)).rejects.toThrow('404');
  });
});
