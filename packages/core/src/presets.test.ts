import { describe, expect, it } from 'vitest';
import { providerPresets, recommendedModelCandidates } from './presets';

describe('recommendedModelCandidates', () => {
  it('tenta os modelos gratuitos antes dos pagos', () => {
    const catalog = ['moonshotai/kimi-k2', 'qwen/qwen3-coder', 'qwen/qwen3-coder:free'];
    const picked = recommendedModelCandidates('openrouter', 'backend', catalog, [
      'qwen/qwen3-coder:free',
    ]);
    expect(picked[0]).toBe('qwen/qwen3-coder:free');
    expect(picked).toContain('moonshotai/kimi-k2');
  });

  it('reconhece ids com prefixo, como os do Gemini', () => {
    const catalog = ['models/gemini-2.5-flash', 'models/gemini-2.5-flash-lite', 'models/gemma-3'];
    expect(recommendedModelCandidates('gemini', 'queen', catalog)[0]).toBe(
      'models/gemini-2.5-flash',
    );
  });

  it('não sugere nada quando o catálogo não tem modelos conhecidos', () => {
    expect(recommendedModelCandidates('groq', 'qa', ['whisper-large-v3'])).toEqual([]);
  });
});

it('todo provedor tem URL de chave e resumo do plano', () => {
  for (const preset of Object.values(providerPresets)) {
    expect(preset.keyUrl).toMatch(/^https:\/\//);
    expect(preset.free.summary.length).toBeGreaterThan(0);
  }
});
