import { describe, expect, it } from 'vitest';
import { OpenAICompatibleClient, readUsage } from './client';
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

describe('assinatura de pensamento do Gemini', () => {
  const signed = {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: 'c1',
              function: { name: 'read_file', arguments: '{"path":"a"}' },
              extra_content: { google: { thought_signature: 'assinatura-123' } },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  };
  const sent = (init: RequestInit) =>
    JSON.parse(String(init.body)).messages as { tool_calls?: Record<string, unknown>[] }[];

  it('guarda a assinatura da chamada e a devolve ao Gemini no passo seguinte', async () => {
    const calls: RequestInit[] = [];
    const gemini = new OpenAICompatibleClient({ ...endpoint, kind: 'gemini' }, (async (
      _url: string,
      init: RequestInit,
    ) => {
      calls.push(init);
      return json(signed);
    }) as unknown as typeof fetch);
    const first = await gemini.chat(request);
    expect(first.message.tool_calls?.[0]?.extra_content).toEqual({
      google: { thought_signature: 'assinatura-123' },
    });
    await gemini.chat({
      model: 'm',
      messages: [
        ...request.messages,
        first.message,
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      ],
    });
    expect(sent(calls[1]!)[1]!.tool_calls![0]!.extra_content).toEqual({
      google: { thought_signature: 'assinatura-123' },
    });
  });

  it('depois de trocar para o Gemini, chamadas de outros modelos levam a assinatura substituta', async () => {
    const calls: RequestInit[] = [];
    const gemini = new OpenAICompatibleClient({ ...endpoint, kind: 'gemini' }, (async (
      _url: string,
      init: RequestInit,
    ) => {
      calls.push(init);
      return json(signed);
    }) as unknown as typeof fetch);
    await gemini.chat({
      model: 'm',
      messages: [
        ...request.messages,
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'g1', type: 'function', function: { name: 'list_dir', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'g1', content: 'ok' },
      ],
    });
    expect(sent(calls[0]!)[1]!.tool_calls![0]!.extra_content).toEqual({
      google: { thought_signature: 'skip_thought_signature_validator' },
    });
  });

  it('não manda a assinatura a outro provedor depois de uma troca de modelo', async () => {
    const { api, calls } = client(() => json(signed));
    const first = await new OpenAICompatibleClient({ ...endpoint, kind: 'gemini' }, (async () =>
      json(signed)) as unknown as typeof fetch).chat(request);
    await api.chat({ model: 'm', messages: [...request.messages, first.message] });
    expect(sent(calls[0]!.init)[1]!.tool_calls![0]).not.toHaveProperty('extra_content');
  });
});

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

  it('lê os tokens em cache só quando o provedor informa', () => {
    expect(readUsage({ prompt_tokens: 10, completion_tokens: 2 })).toEqual({
      promptTokens: 10,
      completionTokens: 2,
    });
    expect(
      readUsage({
        prompt_tokens: 10,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 6 },
      }),
    ).toEqual({ promptTokens: 10, completionTokens: 2, cachedTokens: 6 });
    // DeepSeek reports the cache hit under its own name; a zero hit is still a report.
    expect(readUsage({ prompt_tokens: 10, prompt_cache_hit_tokens: 0 })).toEqual({
      promptTokens: 10,
      completionTokens: 0,
      cachedTokens: 0,
    });
    expect(readUsage({ prompt_tokens: 10, prompt_tokens_details: null }).cachedTokens).toBe(
      undefined,
    );
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

  it('no OpenRouter, o teste de conexão confere a chave e não só o catálogo público (caso real)', async () => {
    // From a real run: the catalog listed 400+ models with a key that every chat call refused.
    const { api, calls } = client((url) =>
      url.endsWith('/key')
        ? json({ error: { message: 'User not found.' } }, { status: 401 })
        : json({ data: [{ id: 'a/b:free' }] }),
    );
    await expect(api.testConnection()).rejects.toThrow('Authentication failed (401)');
    expect(calls.map((call) => call.url)).toEqual(['https://api.exemplo.dev/v1/key']);
  });
});
