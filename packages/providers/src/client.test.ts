import { describe, expect, it } from 'vitest';
import { OpenAICompatibleClient } from './client';
import { ProviderError, retryDelay } from './retry';

const endpoint = {
  providerId: 'p1',
  kind: 'openrouter' as const,
  baseUrl: 'https://api.exemplo.dev/v1/',
  apiKey: 'sk-segredo-123456',
};

function client(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond(url, init);
  }) as unknown as typeof fetch;
  return { api: new OpenAICompatibleClient(endpoint, fetchImpl), calls };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });

const request = { model: 'm', messages: [{ role: 'user' as const, content: 'oi' }] };

describe('cliente de provedores compatíveis com OpenAI', () => {
  it('envia a chave, o modelo e as ferramentas, e lê a resposta com chamadas de ferramenta', async () => {
    const { api, calls } = client(() =>
      json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"a"}' } }],
              reasoning: 'pensando',
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      }),
    );
    const response = await api.chat({ ...request, temperature: 0.2, jsonMode: true });

    expect(calls[0]!.url).toBe('https://api.exemplo.dev/v1/chat/completions');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-segredo-123456');
    const payload = JSON.parse(String(calls[0]!.init.body));
    expect(payload).toMatchObject({
      model: 'm',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      usage: { include: true },
    });
    // Ids missing from the provider are filled in, so tool results can refer to them.
    expect(response.message.tool_calls).toEqual([
      {
        id: 'call_0',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"a"}' },
      },
    ]);
    expect(response).toMatchObject({
      reasoning: 'pensando',
      finishReason: 'tool_calls',
      usage: { promptTokens: 12, completionTokens: 3 },
    });
  });

  it('classifica as falhas para decidir se vale tentar de novo', async () => {
    const limited = client(() =>
      json({ error: { message: 'devagar' } }, { status: 429, headers: { 'retry-after': '7' } }),
    );
    const error = await limited.api.chat(request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ status: 429, retryAfterMs: 7_000 });
    expect(retryDelay(error, 0)).toBe(7_000);

    const auth = client(() => json({ error: 'chave inválida' }, { status: 401 }));
    const authError = await auth.api.chat(request).catch((caught: unknown) => caught);
    expect(authError).toMatchObject({ code: 'PROVIDER_AUTH' });
    expect(retryDelay(authError, 0)).toBeNull();

    const offline = client(() => {
      throw new TypeError('fetch failed');
    });
    const offlineError = await offline.api.chat(request).catch((caught: unknown) => caught);
    expect(offlineError).toMatchObject({ status: null });
    expect(retryDelay(offlineError, 0)).toBe(15_000);
  });

  it('reconhece o erro de um gateway dentro de uma resposta 200', async () => {
    const { api } = client(() => json({ error: { message: 'upstream ocupado', code: 429 } }));
    await expect(api.chat(request)).rejects.toMatchObject({ status: 429 });
    const plain = client(() => json({ error: { message: 'modelo recusou' } }));
    const error = await plain.api.chat(request).catch((caught: unknown) => caught);
    expect(retryDelay(error, 0)).toBeNull();
  });

  it('nunca devolve a chave da API numa mensagem de erro', async () => {
    const { api } = client(() =>
      json({ error: { message: `chave sk-segredo-123456 recusada` } }, { status: 400 }),
    );
    const error = (await api.chat(request).catch((caught: unknown) => caught)) as Error;
    expect(error.message).not.toContain('sk-segredo-123456');
  });

  it('rejeita respostas que não são JSON ou não trazem mensagem', async () => {
    const html = client(() => new Response('<html>', { status: 200 }));
    await expect(html.api.chat(request)).rejects.toThrow('not valid JSON');
    const empty = client(() => json({ choices: [] }));
    await expect(empty.api.chat(request)).rejects.toThrow('no message');
  });
});
