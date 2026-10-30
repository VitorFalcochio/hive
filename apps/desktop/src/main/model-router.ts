import {
  providerPresets,
  recommendedModelCandidates,
  type ModelInfo,
  type ModelRoutePlan,
  type ProviderConfig,
  type Worker,
} from '@hive/core';
import type { Repositories } from '@hive/persistence';
import {
  FailoverClient,
  RouteHealth,
  type ChatClient,
  type ChatRoute,
  type RouteSwitch,
} from '@hive/providers';

/** Automatic backups per provider, and in all; enough to ride out limits without a long chain. */
const PER_PROVIDER = 2;
const POOL_SIZE = 8;
/** A provider whose catalog is unknown is listed in the background, at most this often. */
const CATALOG_RETRY_MS = 10 * 60_000;

interface Options {
  repos: Repositories;
  chatFor: (providerId: string) => ChatClient;
  /** Lists a provider's models and stores them; used to learn the catalog of a new provider. */
  refreshCatalog: (providerId: string) => Promise<ModelInfo[]>;
}

type PlannedRoute = ModelRoutePlan;

/**
 * Picks where an agent's calls go: its own provider and model, then the backups it was given,
 * then (when allowed) free models of the other configured providers, chosen per role with the
 * same preferences the recommended setup uses. One shared health record makes every agent skip
 * a model another agent just found exhausted.
 */
export class ModelRouter {
  readonly health = new RouteHealth();
  private readonly catalogTried = new Map<string, number>();

  constructor(private readonly options: Options) {}

  /** The chain of routes for an agent, in the order they are tried; or only its own model. */
  plan(worker: Worker, primaryOnly = false): PlannedRoute[] {
    const { repos } = this.options;
    const settings = repos.getSettings().failover;
    const providers = new Map(repos.providers.list().map((provider) => [provider.id, provider]));
    const usable = (provider: ProviderConfig | undefined): provider is ProviderConfig =>
      !!provider &&
      provider.enabled &&
      (provider.hasCredential || !!providerPresets[provider.kind].keyOptional);
    const chain: PlannedRoute[] = [];
    const seen = new Set<string>();
    const add = (providerId: string, model: string, source: PlannedRoute['source']) => {
      const provider = providers.get(providerId);
      const key = `${providerId}\u0000${model}`;
      if (!usable(provider) || seen.has(key)) return;
      seen.add(key);
      chain.push({
        providerId,
        providerName: provider.name,
        model,
        source,
        restingMs: this.health.resting({ providerId, model }),
      });
    };
    if (worker.providerId && worker.modelId) add(worker.providerId, worker.modelId, 'primary');
    if (primaryOnly || !settings.enabled) return chain;
    for (const backup of worker.fallbacks ?? []) add(backup.providerId, backup.modelId, 'backup');
    if (!settings.automatic) return chain;

    // Other providers first (a separate quota is what helps most), then the agent's own.
    const pool = [...providers.values()]
      .filter(usable)
      .filter((provider) => !settings.freeOnly || providerPresets[provider.kind].free.available)
      .sort(
        (a, b) =>
          Number(a.id === worker.providerId) - Number(b.id === worker.providerId) ||
          a.createdAt.localeCompare(b.createdAt),
      )
      .map((provider) => this.candidates(provider, worker, settings.freeOnly));
    for (let round = 0; round < PER_PROVIDER; round++)
      for (const list of pool) {
        if (chain.filter((route) => route.source === 'automatic').length >= POOL_SIZE) break;
        const model = list[round];
        if (model) add(model.providerId, model.id, 'automatic');
      }
    return chain;
  }

  /** A client for the agent whose calls fail over along its chain. */
  clientFor(worker: Worker, onSwitch: (change: RouteSwitch) => void): ChatClient {
    const toRoute = (planned: PlannedRoute): ChatRoute => ({
      providerId: planned.providerId,
      providerName: planned.providerName,
      model: planned.model,
      client: this.options.chatFor(planned.providerId),
    });
    // Planned again on every call: a provider added or a model chosen mid-task is used at once.
    // The full chain (and any catalog it needs) is only worked out when the model fails.
    return new FailoverClient(
      (full) => this.plan(worker, !full).map(toRoute),
      this.health,
      onSwitch,
    );
  }

  private candidates(provider: ProviderConfig, worker: Worker, freeOnly: boolean): ModelInfo[] {
    const catalog = this.options.repos.listModels(provider.id);
    if (!catalog.length) {
      this.learnCatalog(provider.id);
      return [];
    }
    const isFree = (model: ModelInfo) =>
      /:free$/i.test(model.id) ||
      (model.pricing?.inputPerMTok === 0 && model.pricing.outputPerMTok === 0);
    // Gateways mix free and paid models; there only the free ones count as free.
    const gateway = provider.kind === 'kilo' || provider.kind === 'openrouter';
    const allowed = catalog.filter(
      (model) => model.capabilities.tools !== 'no' && (!freeOnly || !gateway || isFree(model)),
    );
    const byId = new Map(allowed.map((model) => [model.id, model]));
    return recommendedModelCandidates(
      provider.kind,
      worker.role,
      [...byId.keys()],
      allowed.filter(isFree).map((model) => model.id),
    )
      .map((id) => byId.get(id))
      .filter((model): model is ModelInfo => !!model)
      .slice(0, PER_PROVIDER + 1);
  }

  private learnCatalog(providerId: string): void {
    const last = this.catalogTried.get(providerId) ?? 0;
    if (Date.now() - last < CATALOG_RETRY_MS) return;
    this.catalogTried.set(providerId, Date.now());
    void this.options.refreshCatalog(providerId).catch(() => undefined);
  }
}
