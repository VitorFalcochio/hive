import { HiveError, errorMessage } from '@hive/shared';
import { ProviderError } from './retry';
import type { ChatClient, ChatRequest, ChatResponse } from './types';

/** One provider and model a call can go to. */
export interface ChatRoute {
  providerId: string;
  providerName: string;
  model: string;
  client: ChatClient;
}

/** Why a route was left, as shown in the task log. */
export interface RouteSwitch {
  from: ChatRoute;
  to: ChatRoute;
  /** Short reason in Portuguese: "limite de uso (429)", "modelo indisponível (404)"… */
  reason: string;
  /** True when going back to the agent's own model. */
  restored: boolean;
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
/** How long a route is skipped after each kind of failure, when the provider does not say. */
const COOLDOWN = {
  rateLimit: MINUTE,
  quota: 30 * MINUTE,
  payment: 30 * MINUTE,
  auth: 30 * MINUTE,
  missing: 6 * 60 * MINUTE,
  unavailable: 30 * SECOND,
};

const routeKey = (route: Pick<ChatRoute, 'providerId' | 'model'>) =>
  `${route.providerId}\u0000${route.model}`;

/**
 * Which routes are resting and until when, shared by every agent: once one agent finds a model
 * exhausted, the others skip it without spending a call. A provider-wide pause (its gate stops
 * every call after a 429) also deprioritises the provider's other models for that while.
 */
export class RouteHealth {
  private readonly routes = new Map<string, number>();
  private readonly providers = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Milliseconds until the route may be tried again; 0 when it is fine. */
  resting(route: Pick<ChatRoute, 'providerId' | 'model'>): number {
    return Math.max(0, (this.routes.get(routeKey(route)) ?? 0) - this.now());
  }

  providerPaused(providerId: string): number {
    return Math.max(0, (this.providers.get(providerId) ?? 0) - this.now());
  }

  rest(route: Pick<ChatRoute, 'providerId' | 'model'>, ms: number, providerMs = 0): void {
    const key = routeKey(route);
    this.routes.set(key, Math.max(this.routes.get(key) ?? 0, this.now() + ms));
    if (providerMs > 0)
      this.providers.set(
        route.providerId,
        Math.max(this.providers.get(route.providerId) ?? 0, this.now() + providerMs),
      );
  }

  recovered(route: Pick<ChatRoute, 'providerId' | 'model'>): void {
    this.routes.delete(routeKey(route));
  }

  /** Routes resting right now, for the UI and the logs. */
  snapshot(): { key: string; untilMs: number }[] {
    return [...this.routes.entries()]
      .filter(([, until]) => until > this.now())
      .map(([key, until]) => ({ key, untilMs: until - this.now() }));
  }
}

/**
 * Whether another provider or model can help with this failure, and for how long the failed
 * route should rest. Bad requests and cancellations are not the route's fault: they go up as is.
 */
export function failoverCause(
  error: unknown,
): { reason: string; restMs: number; providerMs: number } | null {
  if (error instanceof ProviderError) {
    const { status, retryAfterMs } = error;
    const text = errorMessage(error).toLowerCase();
    if (status === 429) {
      const daily =
        /per[- ]day|daily|quota|free-models-per-day|exceeded your current|insufficient/.test(text);
      const rest = retryAfterMs ?? (daily ? COOLDOWN.quota : COOLDOWN.rateLimit);
      return {
        reason: daily ? 'cota esgotada (429)' : 'limite de uso (429)',
        restMs: Math.max(rest, 5 * SECOND),
        providerMs: retryAfterMs ?? 20 * SECOND,
      };
    }
    if (status === 402)
      return { reason: 'sem créditos (402)', restMs: COOLDOWN.payment, providerMs: 0 };
    if (status === 404)
      return { reason: 'modelo indisponível (404)', restMs: COOLDOWN.missing, providerMs: 0 };
    if (status === null)
      return {
        reason: 'provedor fora do ar',
        restMs: COOLDOWN.unavailable,
        providerMs: COOLDOWN.unavailable,
      };
    if (status === 408 || status >= 500)
      return {
        reason: `falha do provedor (${status})`,
        restMs: COOLDOWN.unavailable,
        providerMs: 0,
      };
    return null;
  }
  if (error instanceof HiveError) {
    if (error.code === 'PROVIDER_AUTH')
      return { reason: 'chave recusada', restMs: COOLDOWN.auth, providerMs: COOLDOWN.auth };
    if (error.code === 'TIMEOUT')
      return { reason: 'sem resposta a tempo', restMs: COOLDOWN.unavailable, providerMs: 0 };
  }
  return null;
}

/**
 * A chat client that moves to the next provider or model as soon as one is exhausted, instead
 * of waiting: the agent's own model first, then its chosen backups, then the automatic pool.
 * It goes back to the agent's model as soon as that model has rested. Only when every route is
 * resting does it fail with a 429 that says how long to wait, which `withRetries` honours.
 *
 * `routes(false)` gives only the agent's own route and `routes(true)` the whole chain, which is
 * worked out only once a failure needs it: a healthy model costs nothing extra.
 *
 * Requests keep their model while on the first route (a soldier may use her own model there);
 * on any other route the route's model replaces it, since model ids are per provider.
 */
export class FailoverClient implements ChatClient {
  private current: ChatRoute | null = null;

  constructor(
    private readonly routes: (full: boolean) => ChatRoute[],
    private readonly health: RouteHealth,
    private readonly onSwitch: (change: RouteSwitch) => void = () => {},
  ) {}

  /** The route the last successful call used. */
  get active(): ChatRoute | null {
    return this.current;
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const primary = this.routes(false)[0];
    if (!primary)
      throw new HiveError('VALIDATION', 'Nenhum provedor configurado para este agente.');
    let last: { error: unknown; reason: string; route: ChatRoute } | null = null;
    // The usual case: the agent's own model, not resting, answers.
    if (this.health.resting(primary) === 0) {
      try {
        return this.succeeded(primary, primary, await primary.client.chat(request, signal), null);
      } catch (error) {
        if (signal?.aborted) throw error;
        const cause = failoverCause(error);
        if (!cause) throw error;
        // With nowhere to go, nothing changes: the provider's own errors and retries apply.
        if (this.routes(true).length <= 1) throw error;
        this.health.rest(primary, cause.restMs, cause.providerMs);
        last = { error, reason: cause.reason, route: primary };
      }
    }
    const routes = this.routes(true);
    if (routes.length <= 1) return primary.client.chat(request, signal);
    // Fresh routes in preference order; a provider paused by its gate goes after the others.
    const order = routes
      .map((route, index) => ({ route, index }))
      .filter(({ route }) => this.health.resting(route) === 0)
      .sort(
        (a, b) =>
          Number(this.health.providerPaused(a.route.providerId) > 0) -
            Number(this.health.providerPaused(b.route.providerId) > 0) || a.index - b.index,
      )
      .map(({ route }) => route);
    for (const route of order) {
      signal?.throwIfAborted();
      const isPrimary = routeKey(route) === routeKey(primary);
      try {
        const response = await route.client.chat(
          isPrimary ? request : { ...request, model: route.model },
          signal,
        );
        return this.succeeded(route, primary, response, last);
      } catch (error) {
        if (signal?.aborted) throw error;
        const cause = failoverCause(error);
        if (!cause) throw error;
        this.health.rest(route, cause.restMs, cause.providerMs);
        last = { error, reason: cause.reason, route };
      }
    }
    // Everything is resting: wait for the first route to come back, then try again.
    const wait = Math.min(
      ...routes.map((route) => this.health.resting(route)).filter((ms) => ms > 0),
    );
    // Capped: a model gone for hours must not hold the task while another may free up sooner.
    const waitMs = Math.min(Number.isFinite(wait) ? wait : COOLDOWN.rateLimit, 5 * MINUTE);
    throw new ProviderError(
      `Todos os ${routes.length} modelos disponíveis estão no limite agora${last ? ` (último: ${last.route.providerName} · ${last.route.model}, ${last.reason})` : ''}. Nova tentativa quando o primeiro liberar.`,
      429,
      Math.max(waitMs, 2 * SECOND),
    );
  }

  private succeeded(
    route: ChatRoute,
    primary: ChatRoute,
    response: ChatResponse,
    last: { reason: string; route: ChatRoute } | null,
  ): ChatResponse {
    this.health.recovered(route);
    const previous = this.current ?? primary;
    if (routeKey(previous) !== routeKey(route))
      this.onSwitch({
        from: last?.route ?? previous,
        to: route,
        reason: last?.reason ?? 'modelo principal descansou',
        restored: routeKey(route) === routeKey(primary),
      });
    this.current = route;
    return response;
  }
}
