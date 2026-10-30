import { describe, expect, it, vi } from 'vitest';
import {
  defaultLimits,
  defaultSettings,
  type ModelInfo,
  type ProviderConfig,
  type ProviderKind,
  type Worker,
} from '@hive/core';
import { HiveDatabase, Repositories } from '@hive/persistence';
import type { ChatClient } from '@hive/providers';
import { ModelRouter } from './model-router';

const at = '2026-10-30T10:00:00.000Z';

function setup() {
  const db = new HiveDatabase(':memory:');
  const repos = new Repositories(db);
  const addProvider = (id: string, kind: ProviderKind, options: Partial<ProviderConfig> = {}) =>
    repos.providers.put({
      id,
      kind,
      name: id,
      baseUrl: 'https://example.test/v1',
      enabled: true,
      hasCredential: true,
      credentialHint: null,
      lastTest: null,
      modelsFetchedAt: null,
      createdAt: `${at}-${id}`,
      ...options,
    });
  const model = (providerId: string, id: string, patch: Partial<ModelInfo> = {}): ModelInfo => ({
    id,
    providerId,
    displayName: id,
    family: null,
    contextWindow: 128_000,
    capabilities: {
      tools: 'yes',
      structuredOutput: 'unknown',
      reasoning: 'unknown',
      vision: 'unknown',
    },
    capabilitySource: 'provider-metadata',
    pricing: null,
    ...patch,
  });
  const worker: Worker = {
    id: 'w',
    name: 'Backend',
    role: 'backend',
    beeColor: null,
    squad: [],
    description: '',
    providerId: 'kilo',
    modelId: 'poolside/laguna-s-2.1:free',
    skills: [],
    tools: [],
    autoApproveCommands: [],
    mcpServers: [],
    systemPrompt: '',
    limits: defaultLimits,
    createdAt: at,
    updatedAt: at,
  };
  const refresh = vi.fn(async () => [] as ModelInfo[]);
  const router = new ModelRouter({
    repos,
    chatFor: () => ({ chat: vi.fn() }) as unknown as ChatClient,
    refreshCatalog: refresh,
  });
  return { db, repos, addProvider, model, worker, router, refresh };
}

describe('cadeia de modelos de um agente', () => {
  it('principal, depois as reservas escolhidas, depois modelos gratuitos de outros provedores', () => {
    const { repos, addProvider, model, worker, router } = setup();
    addProvider('kilo', 'kilo', { hasCredential: false });
    addProvider('groq', 'groq');
    addProvider('openai', 'openai');
    repos.replaceModels('kilo', [
      model('kilo', 'poolside/laguna-s-2.1:free'),
      model('kilo', 'qwen/qwen3-coder:free'),
      model('kilo', 'anthropic/claude-paid', { pricing: { inputPerMTok: 3, outputPerMTok: 15 } }),
    ]);
    repos.replaceModels('groq', [
      model('groq', 'openai/gpt-oss-120b'),
      model('groq', 'llama-3.3-70b-versatile'),
      model('groq', 'whisper-large-v3', {
        capabilities: { tools: 'no', structuredOutput: 'no', reasoning: 'no', vision: 'no' },
      }),
    ]);
    repos.replaceModels('openai', [model('openai', 'gpt-5')]);
    const plan = router.plan({
      ...worker,
      fallbacks: [{ providerId: 'groq', modelId: 'llama-3.3-70b-versatile' }],
    });
    expect(plan[0]).toEqual(
      expect.objectContaining({ source: 'primary', model: 'poolside/laguna-s-2.1:free' }),
    );
    expect(plan[1]).toEqual(
      expect.objectContaining({ source: 'backup', model: 'llama-3.3-70b-versatile' }),
    );
    const automatic = plan.filter((route) => route.source === 'automatic');
    // Another provider's quota comes before the agent's own provider.
    expect(automatic[0]?.providerId).toBe('groq');
    expect(automatic.map((route) => route.model)).toContain('qwen/qwen3-coder:free');
    // Paid models on a gateway, providers without a free tier and models without tools stay out.
    expect(plan.map((route) => route.model)).not.toContain('anthropic/claude-paid');
    expect(plan.map((route) => route.providerId)).not.toContain('openai');
    expect(plan.map((route) => route.model)).not.toContain('whisper-large-v3');
    // No duplicates: the backup is not repeated by the automatic pool.
    expect(new Set(plan.map((route) => `${route.providerId}:${route.model}`)).size).toBe(
      plan.length,
    );
  });

  it('desligado nas configurações, fica só o modelo principal', () => {
    const { repos, addProvider, model, worker, router } = setup();
    addProvider('kilo', 'kilo', { hasCredential: false });
    addProvider('groq', 'groq');
    repos.replaceModels('groq', [model('groq', 'openai/gpt-oss-120b')]);
    repos.saveSettings({
      ...defaultSettings,
      failover: { enabled: false, automatic: true, freeOnly: true },
    });
    expect(router.plan(worker).map((route) => route.source)).toEqual(['primary']);
  });

  it('sem pool automático, usa só as reservas escolhidas', () => {
    const { repos, addProvider, model, worker, router } = setup();
    addProvider('kilo', 'kilo', { hasCredential: false });
    addProvider('groq', 'groq');
    repos.replaceModels('groq', [model('groq', 'openai/gpt-oss-120b')]);
    repos.saveSettings({
      ...defaultSettings,
      failover: { enabled: true, automatic: false, freeOnly: true },
    });
    const plan = router.plan({
      ...worker,
      fallbacks: [{ providerId: 'groq', modelId: 'openai/gpt-oss-120b' }],
    });
    expect(plan.map((route) => route.source)).toEqual(['primary', 'backup']);
  });

  it('provedor desativado ou sem chave fica de fora; catálogo desconhecido é listado em segundo plano', () => {
    const { addProvider, worker, router, refresh } = setup();
    addProvider('kilo', 'kilo', { hasCredential: false });
    addProvider('gemini', 'gemini');
    addProvider('groq', 'groq', { hasCredential: false });
    addProvider('mistral', 'mistral', { enabled: false });
    const plan = router.plan(worker);
    expect(plan.map((route) => route.providerId)).toEqual(['kilo']);
    expect(refresh).toHaveBeenCalledWith('gemini');
    expect(refresh).not.toHaveBeenCalledWith('groq');
  });

  it('mostra quanto tempo um modelo esgotado ainda descansa', () => {
    const { addProvider, worker, router } = setup();
    addProvider('kilo', 'kilo', { hasCredential: false });
    router.health.rest({ providerId: 'kilo', model: worker.modelId! }, 120_000);
    expect(router.plan(worker)[0]?.restingMs).toBeGreaterThan(100_000);
  });
});
