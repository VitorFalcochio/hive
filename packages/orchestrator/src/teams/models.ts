import type { ModelInfo, ProviderConfig, ProviderKind } from '@hive/core';

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
  nemotron: ['nvidia', 'openrouter'],
  claude: ['openrouter'],
};

/** Providers Hive can call now: switched on and with a credential (or not needing one). */
export function usableProvider(provider: ProviderConfig): boolean {
  return provider.enabled && (provider.hasCredential || provider.kind === 'openai-compatible');
}

/**
 * Picks a provider and model already configured in Hive for a member, never asking for new
 * credentials. A named provider must exist and work; a named model must be in its catalog
 * when Hive knows the catalog; a family takes the first matching model of the preferred kinds.
 */
export function chooseTeamModel(
  profile: TeamModelProfile,
  providers: ProviderConfig[],
  modelsOf: (providerId: string) => ModelInfo[],
): TeamModelChoice {
  const usable = providers.filter(usableProvider);
  const family = profile.family?.trim().toLowerCase();
  const matches = (model: ModelInfo) =>
    (!profile.model || model.id === profile.model) &&
    (!family ||
      model.id.toLowerCase().includes(family) ||
      model.displayName.toLowerCase().includes(family) ||
      (model.family ?? '').toLowerCase().includes(family));

  if (profile.providerId) {
    const provider = usable.find((item) => item.id === profile.providerId);
    if (!provider)
      return {
        ok: false,
        reason: `O provedor ${profile.providerId} não está configurado ou ativo no Hive.`,
      };
    const catalog = modelsOf(provider.id);
    if (!catalog.length) {
      if (profile.model) return { ok: true, providerId: provider.id, modelId: profile.model };
      return {
        ok: false,
        reason: `O catálogo de ${provider.name} ainda não foi carregado; informe o modelo.`,
      };
    }
    const model = catalog.find(matches);
    if (!model)
      return {
        ok: false,
        reason: `${provider.name} não oferece ${profile.model ?? profile.family ?? 'esse modelo'}.`,
      };
    return { ok: true, providerId: provider.id, modelId: model.id };
  }

  if (!family && !profile.model)
    return {
      ok: false,
      reason: 'Diga o provedor, o modelo ou a família do modelo (ex.: codex, nemotron).',
    };
  const order: ProviderKind[] = (family ? FAMILY_PROVIDERS[family] : undefined) ?? [];
  const ranked = [...usable].sort((a, b) => rank(order, a.kind) - rank(order, b.kind));
  for (const provider of ranked) {
    if (order.length && !order.includes(provider.kind)) continue;
    const model = modelsOf(provider.id).find(matches);
    if (model) return { ok: true, providerId: provider.id, modelId: model.id };
  }
  return {
    ok: false,
    reason: `Nenhum provedor configurado no Hive oferece ${profile.model ?? family}. Configure um na aba Provedores.`,
  };
}

function rank(order: ProviderKind[], kind: ProviderKind): number {
  const index = order.indexOf(kind);
  return index === -1 ? order.length : index;
}
