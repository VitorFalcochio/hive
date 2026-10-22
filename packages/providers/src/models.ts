import type { Capability, ModelInfo } from '@hive/core';
import type { ProviderEndpoint } from './types';

interface RawModel {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  context_window?: unknown;
  supported_parameters?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
  active?: unknown;
  architecture?: { input_modalities?: unknown };
}

/** Model families are not providers: Nemotron can be served by NVIDIA, OpenRouter and others. */
const families: [RegExp, string][] = [
  [/nemotron/i, 'Nemotron'],
  [/llama/i, 'Llama'],
  [/deepseek/i, 'DeepSeek'],
  [/qwen/i, 'Qwen'],
  [/mistral|mixtral|codestral|devstral/i, 'Mistral'],
  [/gemma/i, 'Gemma'],
  [/gemini/i, 'Gemini'],
  [/claude/i, 'Claude'],
  [/gpt-oss/i, 'GPT-OSS'],
  [/gpt|^o\d/i, 'GPT'],
  [/kimi/i, 'Kimi'],
  [/glm/i, 'GLM'],
  [/phi-/i, 'Phi'],
];

export function modelFamily(id: string): string | null {
  return families.find(([pattern]) => pattern.test(id))?.[1] ?? null;
}

/** Models that are clearly not chat models are hidden from the picker. */
const nonChat =
  /(embed|whisper|tts|dall-e|image|moderation|rerank|guard|transcri|audio|speech|clip|vision-only)/i;

function positiveInt(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function perMillion(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n * 1_000_000 : null;
}

/**
 * Normalise a `GET /models` body. Only OpenRouter publishes per-model tool and structured
 * output support; for the other providers capabilities stay `unknown` until probed.
 */
export function normalizeModels(endpoint: ProviderEndpoint, body: unknown): ModelInfo[] {
  const list = Array.isArray(body) ? body : ((body as { data?: unknown })?.data ?? []);
  if (!Array.isArray(list)) return [];
  const models: ModelInfo[] = [];
  for (const raw of list as RawModel[]) {
    if (typeof raw?.id !== 'string' || !raw.id || nonChat.test(raw.id)) continue;
    if (raw.active === false) continue;
    const supported = Array.isArray(raw.supported_parameters)
      ? (raw.supported_parameters as string[])
      : null;
    const fromList = (names: string[]): Capability =>
      supported ? (names.some((n) => supported.includes(n)) ? 'yes' : 'no') : 'unknown';
    const input = perMillion(raw.pricing?.prompt);
    const output = perMillion(raw.pricing?.completion);
    models.push({
      id: raw.id,
      providerId: endpoint.providerId,
      displayName: typeof raw.name === 'string' && raw.name ? raw.name : raw.id,
      family: modelFamily(raw.id),
      contextWindow: positiveInt(raw.context_length) ?? positiveInt(raw.context_window),
      capabilities: {
        tools: fromList(['tools']),
        structuredOutput: fromList(['structured_outputs', 'response_format']),
        reasoning: fromList(['reasoning', 'include_reasoning']),
        vision: Array.isArray(raw.architecture?.input_modalities)
          ? raw.architecture.input_modalities.includes('image')
            ? 'yes'
            : 'no'
          : 'unknown',
      },
      capabilitySource: supported ? 'provider-metadata' : 'unverified',
      pricing:
        input !== null && output !== null ? { inputPerMTok: input, outputPerMTok: output } : null,
    });
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}
