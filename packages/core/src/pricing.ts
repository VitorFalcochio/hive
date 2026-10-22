import type { ModelInfo } from './domain';

/**
 * Tokens as money. Prices come from the provider's catalog (USD per million tokens); a model
 * is free when its catalog price is zero or its id carries the `:free` tag gateways use.
 */
export function isFreeModel(model: Pick<ModelInfo, 'id' | 'pricing'>): boolean {
  if (/:free$/i.test(model.id)) return true;
  return !!model.pricing && model.pricing.inputPerMTok === 0 && model.pricing.outputPerMTok === 0;
}

/** What a call cost in USD, or null when the catalog has no price for the model. */
export function usageCost(
  model: Pick<ModelInfo, 'id' | 'pricing'>,
  usage: { promptTokens: number; completionTokens: number },
): number | null {
  if (isFreeModel(model)) return 0;
  if (!model.pricing) return null;
  return (
    (usage.promptTokens * model.pricing.inputPerMTok +
      usage.completionTokens * model.pricing.outputPerMTok) /
    1_000_000
  );
}

/** "grátis", or the amount in dollars with enough digits to show fractions of a cent. */
export function formatCost(usd: number): string {
  if (usd === 0) return 'grátis';
  if (usd < 0.0001) return '< US$ 0,0001';
  const digits = usd < 0.01 ? 4 : usd < 1 ? 3 : 2;
  return `US$ ${usd.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** Free models first, then the cheapest; unknown prices last. Ties by id. */
export function compareByPrice(
  a: Pick<ModelInfo, 'id' | 'pricing'>,
  b: Pick<ModelInfo, 'id' | 'pricing'>,
): number {
  const price = (model: Pick<ModelInfo, 'id' | 'pricing'>) =>
    isFreeModel(model)
      ? 0
      : model.pricing
        ? model.pricing.inputPerMTok + model.pricing.outputPerMTok
        : Number.POSITIVE_INFINITY;
  return price(a) - price(b) || a.id.localeCompare(b.id);
}
