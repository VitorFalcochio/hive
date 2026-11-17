import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { HiveError } from '@hive/shared';
import {
  ChatGPTSession,
  signInWithChatGPT,
  verifyIdToken,
  type ChatGPTCredentials,
} from './chatgpt-auth';
import {
  ChatGPTPlanClient,
  planError,
  readResponseStream,
  toResponsesInput,
  toResponsesTools,
} from './chatgpt-client';
import { failoverCause } from './failover';
import { ProviderError, retryDelay } from './retry';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };

function idToken(claims: Record<string, unknown>, kid = 'k1') {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = enc({ alg: 'RS256', kid });
  const body = enc(claims);
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), privateKey).toString(
    'base64url',
  );
  return `${head}.${body}.${signature}`;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** auth.openai.com: discovery, JWKS and the token endpoint. */
function authServer(token: (body: URLSearchParams) => Response) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/.well-known/openid-configuration'))
      return json({
        jwks_uri: 'https://auth.openai.com/jwks',
        revocation_endpoint: 'https://auth.openai.com/revoke',
      });
    if (url === 'https://auth.openai.com/jwks') return json({ keys: [jwk] });
    if (url.endsWith('/oauth/token')) return token(new URLSearchParams(String(init?.body)));
    if (url === 'https://auth.openai.com/revoke') return new Response(null, { status: 200 });
    throw new Error(`unexpected ${url}`);
  });
}

function sse(...events: unknown[]) {
  const text = events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join('');
  // Split mid-event to exercise buffering.
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 17));
      controller.enqueue(bytes.slice(17));
      controller.close();
    },
  });
}

describe('toResponsesInput', () => {
  it('moves leading system text to instructions and maps tool turns', () => {
    const { instructions, input } = toResponsesInput([
      { role: 'system', content: 'You are Hive.' },
      { role: 'user', content: 'list files' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'list_dir', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'a.ts' },
      { role: 'system', content: 'Hurry.' },
    ]);
    expect(instructions).toBe('You are Hive.');
    expect(input).toEqual([
      { role: 'user', content: 'list files' },
      {
        type: 'function_call',
        call_id: 'c1',
        name: 'list_dir',
        namespace: 'hive',
        arguments: '{}',
      },
      { type: 'function_call_output', call_id: 'c1', output: 'a.ts' },
      { role: 'developer', content: 'Hurry.' },
    ]);
  });

  it('maps images to input_image parts', () => {
    const { input } = toResponsesInput([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
        ],
      },
    ]);
    expect(input[0]).toEqual({
      role: 'user',
      content: [
        { type: 'input_text', text: 'see' },
        { type: 'input_image', image_url: 'data:image/png;base64,AA' },
      ],
    });
  });

  it('groups tools in a namespace', () => {
    const [namespace] = toResponsesTools([
      { type: 'function', function: { name: 'ping', description: 'd', parameters: {} } },
    ]);
    expect(namespace).toMatchObject({ type: 'namespace', name: 'hive', tools: [{ name: 'ping' }] });
  });
});

describe('readResponseStream', () => {
  it('returns the completed response', async () => {
    const body = await readResponseStream(
      sse(
        { type: 'response.output_text.delta', delta: 'hi' },
        { type: 'response.completed', response: { status: 'completed', output: [] } },
      ),
    );
    expect(body.status).toBe('completed');
  });

  it('turns an exhausted plan into a non-retried, long failover rest', async () => {
    const error = await readResponseStream(
      sse({
        type: 'response.failed',
        response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } },
      }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(retryDelay(error, 0)).toBeNull();
    expect(failoverCause(error)).toMatchObject({ reason: 'limite do plano ChatGPT' });
  });

  it('fails a stream that ends without a terminal event, retryably', async () => {
    const error = await readResponseStream(sse({ type: 'response.output_text.delta' })).catch(
      (caught: unknown) => caught,
    );
    expect(retryDelay(error, 0)).not.toBeNull();
  });
});

describe('planError', () => {
  it('marks an ineligible plan as an auth problem', () => {
    const error = planError(403, { code: 'subscription_sharing_user_not_eligible' });
    expect(error).toBeInstanceOf(HiveError);
    expect(error.code).toBe('PROVIDER_AUTH');
  });
});

describe('ChatGPTPlanClient', () => {
  it('sends a stateless streaming request and reads text, tool calls and usage', async () => {
    const tokens = { accessToken: vi.fn(async () => 'tok') };
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(payload).toMatchObject({ store: false, stream: true, instructions: 'sys' });
      expect(payload).not.toHaveProperty('temperature');
      expect(payload).not.toHaveProperty('max_output_tokens');
      return new Response(
        sse({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [
              { type: 'reasoning', summary: [{ text: 'thinking' }] },
              { type: 'message', content: [{ type: 'output_text', text: 'ok' }] },
              { type: 'function_call', call_id: 'c9', name: 'read_file', arguments: '{"p":1}' },
            ],
            usage: { input_tokens: 10, output_tokens: 3 },
          },
        }),
      );
    });
    const client = new ChatGPTPlanClient('p1', tokens, fetchImpl as typeof fetch);
    const response = await client.chat({
      model: 'gpt-x',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      temperature: 0.2,
      maxTokens: 50,
    });
    expect(response.message.content).toBe('ok');
    expect(response.message.tool_calls?.[0]).toMatchObject({
      id: 'c9',
      function: { name: 'read_file' },
    });
    expect(response.reasoning).toBe('thinking');
    expect(response.finishReason).toBe('tool_calls');
    expect(response.usage).toEqual({ promptTokens: 10, completionTokens: 3 });
    const headers = fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok');
  });

  it('reads items streamed one by one when the final event lists no output', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          sse(
            {
              type: 'response.output_item.done',
              item: { type: 'function_call', call_id: 'c1', name: 'list_dir', arguments: '{}' },
            },
            {
              type: 'response.completed',
              response: { status: 'completed', output: [], usage: { output_tokens: 20 } },
            },
          ),
        ),
    );
    const client = new ChatGPTPlanClient('p1', { accessToken: async () => 't' }, fetchImpl);
    const response = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    expect(response.message.tool_calls?.[0]?.function.name).toBe('list_dir');
  });

  it('fails loudly on a reply it cannot read instead of passing it as final', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          sse({
            type: 'response.completed',
            response: { output: [{ type: 'mystery' }], usage: { output_tokens: 20 } },
          }),
        ),
    );
    const client = new ChatGPTPlanClient('p1', { accessToken: async () => 't' }, fetchImpl);
    await expect(
      client.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow(/mystery/);
  });

  it('refreshes the token once after a 401', async () => {
    const tokens = { accessToken: vi.fn(async (force?: boolean) => (force ? 'new' : 'old')) };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ error: { message: 'expired' } }, 401))
      .mockResolvedValueOnce(
        json({
          models: [
            { slug: 'gpt-x', display_name: 'GPT X', visibility: 'list' },
            { slug: 'hidden', visibility: 'hide' },
          ],
        }),
      );
    const client = new ChatGPTPlanClient('p1', tokens, fetchImpl as typeof fetch);
    const models = await client.listModels();
    expect(models.map((model) => model.id)).toEqual(['gpt-x']);
    expect(models[0]).toMatchObject({ displayName: 'GPT X', capabilities: { tools: 'yes' } });
    expect(tokens.accessToken).toHaveBeenLastCalledWith(true);
  });
});

describe('verifyIdToken', () => {
  const fetchImpl = authServer(() => json({}));
  const claims = {
    iss: 'https://auth.openai.com',
    aud: 'oaiapp_1',
    sub: 'user-1',
    email: 'a@b.c',
    nonce: 'n',
    exp: Math.floor(Date.now() / 1000) + 3600,
  };

  it('accepts a token signed by an OpenAI key', async () => {
    await expect(
      verifyIdToken(
        idToken(claims),
        { clientId: 'oaiapp_1', nonce: 'n' },
        fetchImpl as typeof fetch,
      ),
    ).resolves.toEqual({ sub: 'user-1', email: 'a@b.c' });
  });

  it('rejects a wrong audience, nonce or signature', async () => {
    const check = (token: string, nonce = 'n') =>
      verifyIdToken(token, { clientId: 'oaiapp_1', nonce }, fetchImpl as typeof fetch);
    await expect(check(idToken({ ...claims, aud: 'other' }))).rejects.toThrow(/aplicativo/);
    await expect(check(idToken(claims), 'm')).rejects.toThrow(/nonce/);
    const tampered = idToken(claims).replace(/\.[^.]+$/, '.AAAA');
    await expect(check(tampered)).rejects.toThrow(/assinatura/);
  });
});

describe('ChatGPTSession', () => {
  const base: ChatGPTCredentials = {
    clientId: 'oaiapp_1',
    sub: 'u',
    email: null,
    accessToken: 'a1',
    refreshToken: 'r1',
    idToken: 'x',
    expiresAt: 0,
    scope: '',
  };

  it('refreshes once for concurrent callers and persists the rotated token', async () => {
    const fetchImpl = authServer((body) => {
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('client_id')).toBe('oaiapp_1');
      return json({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 });
    });
    const persist = vi.fn();
    const session = new ChatGPTSession(base, persist, fetchImpl as typeof fetch);
    const [one, two] = await Promise.all([session.accessToken(), session.accessToken()]);
    expect([one, two]).toEqual(['a2', 'a2']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: 'r2' }));
    await expect(session.accessToken()).resolves.toBe('a2');
  });

  it('forgets the tokens when the refresh token is dead', async () => {
    const fetchImpl = authServer(() => json({ error: 'invalid_grant' }, 400));
    const persist = vi.fn();
    const session = new ChatGPTSession(base, persist, fetchImpl as typeof fetch);
    await expect(session.accessToken()).rejects.toThrow(/Entre de novo/);
    expect(persist).toHaveBeenCalledWith(null);
  });
});

describe('signInWithChatGPT', () => {
  it('registers, exchanges the code with PKCE and checks the plan scope', async () => {
    let nonce = '';
    const fetchImpl = authServer((body) => {
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('client_id')).toBe('oaiapp_new');
      expect(body.get('code_verifier')).toBeTruthy();
      expect(body.get('resource')).toBe('https://api.openai.com/v1');
      return json({
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 3600,
        scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
        id_token: idToken({
          iss: 'https://auth.openai.com',
          aud: 'oaiapp_new',
          sub: 'user-1',
          email: 'a@b.c',
          nonce,
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      });
    });
    const credentials = await signInWithChatGPT({
      hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000',
      appName: 'Hive',
      registration: null,
      fetchImpl: fetchImpl as typeof fetch,
      // The "browser": approve and follow the redirect to the loopback callback.
      openBrowser: async (url) => {
        const params = new URL(url).searchParams;
        expect(params.get('client_id')).toBe('dynamic_agent_client');
        expect(params.get('agent_name_hint')).toBe('Hive');
        expect(params.get('scope')).toContain('chatgpt.tokens.use.direct');
        expect(params.get('code_challenge_method')).toBe('S256');
        nonce = params.get('nonce')!;
        const callback = new URL(params.get('redirect_uri')!);
        expect(callback.hostname).toBe('127.0.0.1');
        callback.search = new URLSearchParams({
          code: 'c',
          state: params.get('state')!,
          client_id: 'oaiapp_new',
        }).toString();
        const page = await fetch(callback);
        expect(page.status).toBe(200);
      },
    });
    expect(credentials).toMatchObject({
      clientId: 'oaiapp_new',
      sub: 'user-1',
      email: 'a@b.c',
      accessToken: 'at',
      refreshToken: 'rt',
    });
  });

  it('stops when the user does not grant plan usage', async () => {
    let nonce = '';
    const fetchImpl = authServer(() =>
      json({
        access_token: 'at',
        scope: 'openid profile email',
        id_token: idToken({
          iss: 'https://auth.openai.com',
          aud: 'oaiapp_1',
          sub: 'user-1',
          nonce,
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      }),
    );
    await expect(
      signInWithChatGPT({
        hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000',
        appName: 'Hive',
        registration: { clientId: 'oaiapp_1', sub: 'user-1', email: null },
        fetchImpl: fetchImpl as typeof fetch,
        openBrowser: async (url) => {
          const params = new URL(url).searchParams;
          expect(params.get('client_id')).toBe('oaiapp_1');
          expect(params.has('agent_name_hint')).toBe(false);
          nonce = params.get('nonce')!;
          const callback = new URL(params.get('redirect_uri')!);
          callback.search = new URLSearchParams({
            code: 'c',
            state: params.get('state')!,
          }).toString();
          await fetch(callback);
        },
      }),
    ).rejects.toThrow(/uso do plano ChatGPT não foi autorizado/);
  });
});
