import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { HiveError, errorMessage, secretRedactor } from '@hive/shared';

/**
 * OpenAI's "Sign in with ChatGPT" for open-source, locally run apps: OAuth with PKCE and dynamic
 * client registration, through a loopback callback. The tokens it yields let calls to the public
 * Responses API spend the user's ChatGPT plan instead of an API balance.
 * https://developers.openai.com/siwc/token-sharing-open-source
 */
export const CHATGPT_ISSUER = 'https://auth.openai.com';
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';
const AUTHORIZE_URL = `${CHATGPT_ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${CHATGPT_ISSUER}/api/accounts/oauth/token`;
const DISCOVERY_URL = `${CHATGPT_ISSUER}/.well-known/openid-configuration`;
/** Reserved public id for the first sign-in; the callback returns the client id issued for it. */
const DYNAMIC_CLIENT = 'dynamic_agent_client';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const CALLBACK_PATH = '/auth/callback';
const PREFERRED_PORT = 1455;
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
/** Refresh this long before the access token (1 h) expires. */
const REFRESH_MARGIN_MS = 5 * 60_000;

type FetchLike = typeof fetch;

/** Everything kept for one signed-in account; stored encrypted, never logged. */
export interface ChatGPTCredentials {
  /** Issued for this account and host at the first sign-in (`oaiapp_…`), reused afterwards. */
  clientId: string;
  /** Verified account identity (ID token `sub`). */
  sub: string;
  email: string | null;
  accessToken: string;
  refreshToken: string | null;
  idToken: string;
  /** Epoch ms. */
  expiresAt: number;
  scope: string;
}

/** What survives a sign-out, so the next sign-in reuses the same registration. */
export interface ChatGPTRegistration {
  clientId: string;
  sub: string;
  email: string | null;
}

const base64url = (data: Buffer) => data.toString('base64url');

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

export function authorizeUrl(options: {
  redirectUri: string;
  hostId: string;
  state: string;
  nonce: string;
  challenge: string;
  registration: ChatGPTRegistration | null;
  appName: string;
}): string {
  const params = new URLSearchParams({
    client_id: options.registration?.clientId ?? DYNAMIC_CLIENT,
    ext_agent_host_id: options.hostId,
    response_type: 'code',
    redirect_uri: options.redirectUri,
    scope: SCOPES,
    resource: CHATGPT_RESOURCE,
    state: options.state,
    nonce: options.nonce,
    code_challenge_method: 'S256',
    code_challenge: options.challenge,
  });
  // The name is registration metadata: sent only the first time.
  if (!options.registration) params.set('agent_name_hint', options.appName);
  if (options.registration?.email) params.set('login_hint', options.registration.email);
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(
  body: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new ChatGPTAuthError(
      'network',
      `Não foi possível falar com auth.openai.com: ${errorMessage(error)}`,
    );
  }
  let json: TokenResponse = {};
  try {
    json = (await response.json()) as TokenResponse;
  } catch {
    // keep empty
  }
  for (const token of [json.access_token, json.refresh_token, json.id_token])
    if (token) secretRedactor.register(token);
  if (!response.ok || json.error) {
    const code = json.error ?? `http_${response.status}`;
    const terminal = TERMINAL_GRANT_ERRORS.has(code) || response.status === 400;
    throw new ChatGPTAuthError(
      terminal ? 'expired' : response.status >= 500 ? 'network' : 'rejected',
      `A OpenAI recusou o login (${code}). ${json.error_description ?? ''}`.trim(),
    );
  }
  if (!json.access_token) throw new ChatGPTAuthError('rejected', 'A OpenAI não devolveu um token.');
  return json;
}

const TERMINAL_GRANT_ERRORS = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

/**
 * `expired`: the tokens are unusable and the user must sign in again. `network`: passing, keep
 * the tokens. `rejected`: a configuration or consent problem a retry will not fix.
 */
export class ChatGPTAuthError extends HiveError {
  constructor(
    readonly reason: 'expired' | 'network' | 'rejected' | 'cancelled',
    message: string,
  ) {
    super(reason === 'network' ? 'PROVIDER' : 'PROVIDER_AUTH', message);
  }
}

/* ------------------------------------------------------------------ ID token */

interface IdClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nonce?: string;
  sub?: string;
  email?: string;
}

function decodePart<T>(part: string | undefined): T {
  try {
    return JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8')) as T;
  } catch {
    throw new ChatGPTAuthError('rejected', 'O ID token da OpenAI está malformado.');
  }
}

let jwksCache: { keys: (JsonWebKey & { kid?: string })[]; at: number } | null = null;

async function signingKeys(fetchImpl: FetchLike, refresh = false) {
  if (jwksCache && !refresh && Date.now() - jwksCache.at < 60 * 60_000) return jwksCache.keys;
  const get = async (url: string) => {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  };
  try {
    const discovery = await get(DISCOVERY_URL);
    const jwks = await get(String(discovery.jwks_uri));
    jwksCache = { keys: (jwks.keys ?? []) as (JsonWebKey & { kid?: string })[], at: Date.now() };
    return jwksCache.keys;
  } catch (error) {
    throw new ChatGPTAuthError(
      'network',
      `Não foi possível obter as chaves da OpenAI: ${errorMessage(error)}`,
    );
  }
}

/** Verifies the ID token's signature against OpenAI's JWKS and its claims. */
export async function verifyIdToken(
  idToken: string,
  expected: { clientId: string; nonce: string | null },
  fetchImpl: FetchLike = fetch,
  now = Date.now(),
): Promise<{ sub: string; email: string | null }> {
  const [h, p, s] = idToken.split('.');
  const header = decodePart<{ alg?: string; kid?: string }>(h);
  const claims = decodePart<IdClaims>(p);
  const algorithms: Record<string, { hash: string; ec: boolean }> = {
    RS256: { hash: 'sha256', ec: false },
    ES256: { hash: 'sha256', ec: true },
  };
  const alg = algorithms[header.alg ?? ''];
  if (!alg)
    throw new ChatGPTAuthError('rejected', `Algoritmo de ID token inesperado: ${header.alg}.`);
  let keys = await signingKeys(fetchImpl);
  let jwk = keys.find((key) => key.kid === header.kid);
  if (!jwk) {
    keys = await signingKeys(fetchImpl, true);
    jwk = keys.find((key) => key.kid === header.kid);
  }
  if (!jwk)
    throw new ChatGPTAuthError('rejected', 'O ID token foi assinado por uma chave desconhecida.');
  const valid = verify(
    alg.hash,
    Buffer.from(`${h}.${p}`),
    alg.ec
      ? { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }
      : createPublicKey({ key: jwk, format: 'jwk' }),
    Buffer.from(s ?? '', 'base64url'),
  );
  if (!valid) throw new ChatGPTAuthError('rejected', 'A assinatura do ID token não confere.');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== CHATGPT_ISSUER)
    throw new ChatGPTAuthError('rejected', 'Emissor do ID token inválido.');
  if (!audiences.includes(expected.clientId))
    throw new ChatGPTAuthError('rejected', 'O ID token não é para este aplicativo.');
  if (expected.nonce !== null && claims.nonce !== expected.nonce)
    throw new ChatGPTAuthError('rejected', 'O nonce do ID token não confere.');
  // A refreshed ID token may be the old one; expiry only matters right after sign-in.
  if (expected.nonce !== null && (claims.exp ?? 0) * 1000 < now - 60_000)
    throw new ChatGPTAuthError('rejected', 'O ID token já expirou.');
  if (!claims.sub) throw new ChatGPTAuthError('rejected', 'O ID token não identifica a conta.');
  return { sub: claims.sub, email: claims.email ?? null };
}

/* ------------------------------------------------------------------ Loopback sign-in */

const page = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>Hive</title><body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>${title}</h2><p>${text}</p></div>`;

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    });
  });
}

/**
 * Runs the whole browser sign-in: starts the loopback listener, opens the consent page, waits
 * for the callback, exchanges the code and validates the ID token and the plan scope.
 */
export async function signInWithChatGPT(options: {
  hostId: string;
  appName: string;
  registration: ChatGPTRegistration | null;
  openBrowser: (url: string) => Promise<void> | void;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}): Promise<ChatGPTCredentials> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const state = base64url(randomBytes(24));
  const nonce = base64url(randomBytes(24));
  const { verifier, challenge } = pkcePair();

  let settle!: (result: { code: string; clientId: string | null } | Error) => void;
  const callback = new Promise<{ code: string; clientId: string | null } | Error>(
    (resolve) => (settle = resolve),
  );
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end();
      return;
    }
    const reply = (ok: boolean, text: string) => {
      response.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
      response.end(page(ok ? 'Pronto' : 'Não foi possível entrar', text));
    };
    if (url.searchParams.get('state') !== state) {
      reply(false, 'Resposta inesperada. Volte ao Hive e tente de novo.');
      return;
    }
    const error = url.searchParams.get('error');
    if (error) {
      reply(false, 'O acesso não foi autorizado. Você pode fechar esta aba.');
      settle(
        new ChatGPTAuthError(
          error === 'access_denied' ? 'cancelled' : 'rejected',
          error === 'access_denied'
            ? 'O login com o ChatGPT foi cancelado.'
            : `O ChatGPT recusou o login (${error}).`,
        ),
      );
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      reply(false, 'Resposta sem código de autorização.');
      settle(new ChatGPTAuthError('rejected', 'O ChatGPT não devolveu um código de autorização.'));
      return;
    }
    reply(true, 'Hive conectado ao seu ChatGPT. Você pode fechar esta aba e voltar ao Hive.');
    settle({ code, clientId: url.searchParams.get('client_id') });
  });

  let port: number;
  try {
    port = await listen(server, PREFERRED_PORT);
  } catch {
    // Port taken (Codex CLI uses it too): any free port works, the path and host stay the same.
    port = await listen(server, 0);
  }
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const timer = setTimeout(
    () =>
      settle(new ChatGPTAuthError('cancelled', 'O login com o ChatGPT expirou. Tente de novo.')),
    SIGN_IN_TIMEOUT_MS,
  );
  const onAbort = () =>
    settle(new ChatGPTAuthError('cancelled', 'O login com o ChatGPT foi cancelado.'));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await options.openBrowser(
      authorizeUrl({
        redirectUri,
        hostId: options.hostId,
        state,
        nonce,
        challenge,
        registration: options.registration,
        appName: options.appName,
      }),
    );
    const result = await callback;
    if (result instanceof Error) throw result;

    const known = options.registration?.clientId ?? null;
    if (known && result.clientId && result.clientId !== known)
      throw new ChatGPTAuthError(
        'rejected',
        'O ChatGPT devolveu outro aplicativo registrado. Tente de novo.',
      );
    const clientId = known ?? result.clientId;
    if (!clientId)
      throw new ChatGPTAuthError('rejected', 'O registro no ChatGPT não terminou (sem client_id).');

    const tokens = await tokenRequest(
      {
        grant_type: 'authorization_code',
        client_id: clientId,
        code: result.code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: CHATGPT_RESOURCE,
      },
      fetchImpl,
    );
    if (!tokens.id_token)
      throw new ChatGPTAuthError('rejected', 'A OpenAI não devolveu o ID token.');
    const identity = await verifyIdToken(tokens.id_token, { clientId, nonce }, fetchImpl);
    if (options.registration && options.registration.sub !== identity.sub)
      throw new ChatGPTAuthError(
        'rejected',
        `Esta conexão é da conta ${options.registration.email ?? 'anterior'}. Entre com ela, ou adicione outro provedor ChatGPT para outra conta.`,
      );
    const scope = tokens.scope ?? '';
    if (!scope.split(/\s+/).includes(PLAN_SCOPE))
      throw new ChatGPTAuthError(
        'rejected',
        'O login funcionou, mas o uso do plano ChatGPT não foi autorizado. Entre de novo e marque a opção de usar o seu plano.',
      );
    return {
      clientId,
      sub: identity.sub,
      email: identity.email,
      accessToken: tokens.access_token!,
      refreshToken: tokens.refresh_token ?? null,
      idToken: tokens.id_token,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      scope,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    server.close();
    server.closeAllConnections();
  }
}

/* ------------------------------------------------------------------ Session */

/**
 * One signed-in account: hands out a fresh access token, refreshing it one at a time (the refresh
 * token rotates, so two refreshes racing would burn it) and persisting every replacement.
 */
export class ChatGPTSession {
  private refreshing: Promise<ChatGPTCredentials> | null = null;

  constructor(
    private credentials: ChatGPTCredentials,
    private readonly persist: (credentials: ChatGPTCredentials | null) => void,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {
    secretRedactor.register(credentials.accessToken);
    if (credentials.refreshToken) secretRedactor.register(credentials.refreshToken);
  }

  get account(): ChatGPTRegistration {
    const { clientId, sub, email } = this.credentials;
    return { clientId, sub, email };
  }

  /** A token valid for a while yet; `force` refreshes even if it looks valid (after a 401). */
  async accessToken(force = false): Promise<string> {
    if (!force && this.credentials.expiresAt - REFRESH_MARGIN_MS > this.now())
      return this.credentials.accessToken;
    this.refreshing ??= this.refresh().finally(() => (this.refreshing = null));
    return (await this.refreshing).accessToken;
  }

  private async refresh(): Promise<ChatGPTCredentials> {
    const current = this.credentials;
    if (!current.refreshToken) {
      this.persist(null);
      throw new ChatGPTAuthError(
        'expired',
        'A sessão do ChatGPT expirou. Entre de novo em Provedores.',
      );
    }
    try {
      const tokens = await tokenRequest(
        {
          grant_type: 'refresh_token',
          client_id: current.clientId,
          refresh_token: current.refreshToken,
          resource: CHATGPT_RESOURCE,
        },
        this.fetchImpl,
      );
      this.credentials = {
        ...current,
        accessToken: tokens.access_token!,
        refreshToken: tokens.refresh_token ?? current.refreshToken,
        idToken: tokens.id_token ?? current.idToken,
        expiresAt: this.now() + (tokens.expires_in ?? 3600) * 1000,
        scope: tokens.scope ?? current.scope,
      };
      this.persist(this.credentials);
      return this.credentials;
    } catch (error) {
      if (error instanceof ChatGPTAuthError && error.reason === 'expired') {
        this.persist(null);
        throw new ChatGPTAuthError(
          'expired',
          'A sessão do ChatGPT expirou ou foi desconectada. Entre de novo em Provedores.',
        );
      }
      throw error;
    }
  }
}

/**
 * Revokes the refresh token. Returns false when OpenAI could not confirm it; the caller clears
 * the local tokens anyway and tells the user where to disconnect the app.
 */
export async function revokeChatGPT(
  credentials: ChatGPTCredentials,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  if (!credentials.refreshToken) return true;
  try {
    const discovery = (await (
      await fetchImpl(DISCOVERY_URL, { signal: AbortSignal.timeout(15_000) })
    ).json()) as { revocation_endpoint?: string };
    if (!discovery.revocation_endpoint) return false;
    const response = await fetchImpl(discovery.revocation_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: credentials.refreshToken,
        token_type_hint: 'refresh_token',
        client_id: credentials.clientId,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
