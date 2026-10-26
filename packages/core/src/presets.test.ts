import { describe, expect, it } from 'vitest';
import { workerSchema } from './domain';
import {
  beeColorOf,
  nextBeeColor,
  providerPresets,
  recommendedModelCandidates,
  soldierRoles,
  squadOf,
} from './presets';

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

describe('cores das abelhas', () => {
  it('usa a cor escolhida, senão a da função, e nunca o dourado da Queen num agente próprio', () => {
    expect(beeColorOf({ id: 'a', role: 'frontend', beeColor: 'lime' })).toBe('lime');
    expect(beeColorOf({ id: 'a', role: 'queen', beeColor: null })).toBe('gold');
    expect(beeColorOf({ id: 'a', role: 'backend', beeColor: null })).toBe('orange');
    for (const id of ['w1', 'w2', 'worker_xyz', ''])
      expect(beeColorOf({ id, role: 'custom', beeColor: null })).not.toBe('gold');
  });

  it('sugere uma cor que ainda ninguém usa para um agente novo', () => {
    const team = (['queen', 'architect', 'frontend', 'backend', 'qa', 'reviewer'] as const).map(
      (role) => ({ id: role, role, beeColor: null }),
    );
    expect(['indigo', 'silver']).toContain(nextBeeColor(team));
    expect(nextBeeColor([...team, { id: 'x', role: 'custom', beeColor: 'indigo' }])).toBe('silver');
  });

  it('lê agentes salvos antes das cores existirem', () => {
    const stored = {
      id: 'w',
      name: 'Antigo',
      role: 'qa',
      description: '',
      providerId: null,
      modelId: null,
      skills: [],
      tools: [],
      autoApproveCommands: [],
      mcpServers: [],
      systemPrompt: '',
      limits: {
        maxSteps: 10,
        maxTokens: 10_000,
        commandTimeoutSec: 60,
        taskTimeoutMin: 10,
        temperature: null,
      },
      createdAt: '',
      updatedAt: '',
    };
    expect(workerSchema.parse(stored).beeColor).toBeNull();
    expect(workerSchema.parse(stored).squad).toEqual([]);
  });
});

describe('esquadrão', () => {
  it('dá às capitãs as cinco soldadas, ligadas, e guarda só o que mudou', () => {
    const squad = squadOf({
      role: 'frontend',
      squad: [{ role: 'tester', enabled: false, modelId: 'x:free' }],
    });
    expect(squad.map((soldier) => soldier.role)).toEqual(soldierRoles);
    expect(squad[0]).toEqual({ role: 'scout', enabled: true, modelId: null });
    expect(squad[2]).toEqual({ role: 'tester', enabled: false, modelId: 'x:free' });
  });

  it('não dá esquadrão para a Queen', () => {
    expect(squadOf({ role: 'queen', squad: [] })).toEqual([]);
  });
});
