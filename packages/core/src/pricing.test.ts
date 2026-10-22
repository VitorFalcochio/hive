import { describe, expect, it } from 'vitest';
import { compareByPrice, formatCost, isFreeModel, usageCost } from './pricing';

const priced = (id: string, input: number | null, output = input) => ({
  id,
  pricing: input === null ? null : { inputPerMTok: input, outputPerMTok: output! },
});

describe('tokens como moeda', () => {
  it('reconhece modelos grátis e calcula o custo de uma chamada', () => {
    expect(isFreeModel(priced('minimax/m3:free', null))).toBe(true);
    expect(isFreeModel(priced('a/b', 0))).toBe(true);
    expect(
      usageCost(priced('a/b', 0.15, 0.6), { promptTokens: 10_000, completionTokens: 1_000 }),
    ).toBeCloseTo(0.0021);
    expect(usageCost(priced('a/b', null), { promptTokens: 1, completionTokens: 1 })).toBeNull();
    expect(formatCost(0)).toBe('grátis');
    expect(formatCost(0.0021)).toBe('US$ 0,0021');
    expect(formatCost(0.00001)).toBe('< US$ 0,0001');
  });

  it('ordena os grátis primeiro, depois os mais baratos e por último os sem preço', () => {
    const models = [
      priced('z/caro', 5),
      priced('a/sem-preco', null),
      priced('m/x:free', null),
      priced('b/barato', 0.1),
      priced('c/zero', 0),
    ];
    expect(models.sort(compareByPrice).map((model) => model.id)).toEqual([
      'c/zero',
      'm/x:free',
      'b/barato',
      'z/caro',
      'a/sem-preco',
    ]);
  });
});
