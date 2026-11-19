import {
  isFreeModel,
  providerPresets,
  recommendedModelCandidates,
  type ModelInfo,
  type ProviderConfig,
  type ProviderKind,
  type WorkerRole,
} from '@hive/core';

/** What a leader may ask for: a provider it names, a model, or a model family such as "codex". */
export interface TeamModelProfile {
  providerId?: string;
  model?: string;
  family?: string;
}

export type TeamModelChoice =
  { ok: true; providerId: string; modelId: string } | { ok: false; reason: string };

/**
 * Where each family is looked for first. The official ChatGPT sign-in comes first for Codex;
 * Nemotron is served by NVIDIA and also by OpenRouter. Anything else is looked up everywhere.
 */
const FAMILY_PROVIDERS: Record<string, ProviderKind[]> = {
  codex: ['chatgpt', 'openai', 'openrouter'],
  gpt: ['chatgpt', 'openai', 'openrouter'],
  nemotron: ['nvidia', 'kilo', 'openrouter'],
  claude: ['openrouter', 'kilo'],
};

/**
 * Providers that serve a family through a plan with its own model names: the ChatGPT sign-in
 * runs Codex on the plan's models, which are not called "codex".
 */
const PLAN_FAMILIES: Record<string, ProviderKind[]> = { codex: ['chatgpt'] };

/** Gateways mix free and paid models: there, only the free ones are free. */
const GATEWAYS = new Set<ProviderKind>(['kilo', 'openrouter']);

/** Providers Hive can call now: switched on and with a credential (or not needing one). */
export function usableProvider(provider: ProviderConfig): boolean {
  return provider.enabled && (provider.hasCredential || provider.kind === 'openai-compatible');
}

/**
 * Whether a model costs nothing beyond what the user already has: a free model (":free" or a
 * published price of zero), a provider whose tier is free (NVIDIA, Groq, Gemini…, the same rule
 * as Hive's free-only model pool), a local server, or the ChatGPT sign-in, which spends the plan
 * the user already pays and never bills extra. A published price above zero is never free.
 */
export function costsNothingExtra(
  provider: ProviderConfig,
  model: Pick<ModelInfo, 'id' | 'pricing'>,
): boolean {
  if (isFreeModel(model)) return true;
  if (model.pricing && (model.pricing.inputPerMTok > 0 || model.pricing.outputPerMTok > 0))
    return false;
  if (provider.kind === 'chatgpt' || provider.kind === 'openai-compatible') return true;
  if (GATEWAYS.has(provider.kind)) return false;
  return providerPresets[provider.kind].free.available;
}

/**
 * Picks a provider and model already configured in Hive for a member, never asking for new
 * credentials. A named provider must exist and work; a named model must be in its catalog
 * when Hive knows the catalog; a family takes the first matching model, the preferred kinds
 * first. With `freeOnly`, models that would cost anything extra are never picked, even when
 * asked for by name.
 */
export function chooseTeamModel(
  profile: TeamModelProfile,
  providers: ProviderConfig[],
  modelsOf: (providerId: string) => ModelInfo[],
  /** The member's role, for the model a plan picks for it. */
  role: WorkerRole = 'backend',
  freeOnly = true,
): TeamModelChoice {
  const usable = providers.filter(usableProvider);
  const family = profile.family?.trim().toLowerCase();
  const matches = (model: ModelInfo) =>
    (!profile.model || model.id === profile.model) &&
    (!family ||
      model.id.toLowerCase().includes(family) ||
      model.displayName.toLowerCase().includes(family) ||
      (model.family ?? '').toLowerCase().includes(family));
  const allowedOn = (provider: ProviderConfig) => (model: ModelInfo) =>
    !freeOnly || costsNothingExtra(provider, model);
  const paid = `${profile.model ?? profile.family ?? 'Esse modelo'} tem custo, e o Hive Teams só usa modelos sem custo extra. Peça um modelo gratuito ou desligue essa trava nas Configurações.`;

  if (profile.providerId) {
    const provider = usable.find((item) => item.id === profile.providerId);
    if (!provider)
      return {
        ok: false,
        reason: `O provedor ${profile.providerId} não está configurado ou ativo no Hive.`,
      };
    const catalog = modelsOf(provider.id);
    if (!catalog.length) {
      if (!profile.model)
        return {
          ok: false,
          reason: `O catálogo de ${provider.name} ainda não foi carregado; informe o modelo.`,
        };
      // Without a catalog the price is unknown: only a provider free by nature is safe.
      if (freeOnly && !costsNothingExtra(provider, { id: profile.model, pricing: null }))
        return { ok: false, reason: paid };
      return { ok: true, providerId: provider.id, modelId: profile.model };
    }
    const found = catalog.filter(matches);
    if (!found.length)
      return {
        ok: false,
        reason: `${provider.name} não oferece ${profile.model ?? profile.family ?? 'esse modelo'}.`,
      };
    const model = found.find(allowedOn(provider));
    if (!model) return { ok: false, reason: paid };
    return { ok: true, providerId: provider.id, modelId: model.id };
  }

  if (!family && !profile.model)
    return {
      ok: false,
      reason: 'Diga o provedor, o modelo ou a família do modelo (ex.: codex, nemotron).',
    };
  // The preferred kinds are looked at first, then every other configured provider: the order
  // ranks, it does not exclude (Claude may be served by a gateway such as Kilo, say).
  const order: ProviderKind[] = (family ? FAMILY_PROVIDERS[family] : undefined) ?? [];
  const ranked = [...usable].sort((a, b) => rank(order, a.kind) - rank(order, b.kind));
  let onlyPaid = false;
  for (const provider of ranked) {
    const catalog = modelsOf(provider.id);
    const found = catalog.filter(matches);
    const model = found.find(allowedOn(provider));
    if (model) return { ok: true, providerId: provider.id, modelId: model.id };
    if (found.length) onlyPaid = true;
    // A plan that serves the family under its own model names (Codex on the ChatGPT sign-in):
    // the model Hive itself picks for this role on that provider.
    if (family && !profile.model && PLAN_FAMILIES[family]?.includes(provider.kind)) {
      const allowed = catalog.filter(allowedOn(provider));
      const [pick] = recommendedModelCandidates(
        provider.kind,
        role,
        allowed.map((item) => item.id),
      );
      if (pick) return { ok: true, providerId: provider.id, modelId: pick };
    }
  }
  if (onlyPaid) return { ok: false, reason: paid };
  return {
    ok: false,
    reason: `Nenhum provedor configurado no Hive oferece ${profile.model ?? family}. Configure um na aba Provedores.`,
  };
}

function rank(order: ProviderKind[], kind: ProviderKind): number {
  const index = order.indexOf(kind);
  return index === -1 ? order.length : index;
}
