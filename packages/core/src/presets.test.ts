import { describe, expect, it } from 'vitest';
import { workerRoleSchema, workerSchema } from './domain';
import { hexToHsl, hslToHex, normalizeHex } from './colors';
import {
  beeColorName,
  beeColorOf,
  beeColors,
  beeSwatches,
  beeSwatchFamilies,
  nextBeeColor,
  providerPresets,
  recommendedModelCandidates,
  roleCategories,
  roleInfo,
  roleOrder,
  rolePresets,
  soldierRoles,
  specialistRoles,
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
    // Colours saved by earlier versions keep the exact shade they had.
    expect(beeColorOf({ id: 'a', role: 'frontend', beeColor: 'lime' })).toBe(
      beeColors.lime.hex.toUpperCase(),
    );
    expect(beeColorOf({ id: 'a', role: 'frontend', beeColor: '#38bdf8' })).toBe('#38BDF8');
    expect(beeColorOf({ id: 'a', role: 'queen', beeColor: null })).toBe('#F5B544');
    expect(beeColorOf({ id: 'a', role: 'backend', beeColor: null })).toBe('#F97316');
    for (const id of ['w1', 'w2', 'worker_xyz', ''])
      expect(beeColorOf({ id, role: 'custom', beeColor: null })).not.toBe('#F5B544');
  });

  it('cada especialista tem a cor padrão do catálogo', () => {
    const expected = {
      explorer: '#38BDF8',
      debugger: '#EF4444',
      security: '#EC4899',
      database: '#10B981',
      performance: '#F59E0B',
      integration: '#6366F1',
      requirements: '#C084FC',
    } as const;
    for (const [role, hex] of Object.entries(expected))
      expect(beeColorOf({ id: 'a', role: role as keyof typeof expected, beeColor: null })).toBe(
        hex,
      );
  });

  it('sugere uma cor da paleta que ainda ninguém usa para um agente novo', () => {
    const team = (['queen', 'architect', 'frontend', 'backend', 'qa', 'reviewer'] as const).map(
      (role) => ({ id: role, role, beeColor: null }),
    );
    const first = nextBeeColor(team);
    expect(beeSwatches.map((swatch) => swatch.hex)).toContain(first);
    const worn = team.map((worker) => beeColorOf(worker));
    expect(worn).not.toContain(first);
    // Once it is worn, another one is suggested.
    expect(nextBeeColor([...team, { id: 'x', role: 'custom', beeColor: first }])).not.toBe(first);
  });

  it('a paleta tem 24 cores em 6 famílias, sem repetir, e cada uma tem nome', () => {
    expect(beeSwatchFamilies).toHaveLength(6);
    expect(beeSwatches).toHaveLength(24);
    expect(new Set(beeSwatches.map((swatch) => swatch.hex)).size).toBe(24);
    for (const swatch of beeSwatches) {
      expect(swatch.hex).toMatch(/^#[0-9A-F]{6}$/);
      expect(beeColorName(swatch.hex)).toBe(swatch.label);
    }
    expect(beeColorName('#123456')).toBe('Personalizada');
    expect(beeColorName(beeColors.cyan.hex)).toBe('Ciano');
  });

  it('valida HEX e aceita só cores, na forma #RRGGBB', () => {
    expect(normalizeHex('#38bdf8')).toBe('#38BDF8');
    expect(normalizeHex('38BDF8')).toBe('#38BDF8');
    expect(normalizeHex(' #fff ')).toBe('#FFFFFF');
    for (const bad of ['', '#', '#12345', '#1234567', 'azul', '#GGGGGG', '#12 456'])
      expect(normalizeHex(bad)).toBeNull();
    // The stored value accepts a named colour of earlier versions or a HEX, nothing else.
    const stored = (beeColor: unknown) => workerSchema.shape.beeColor.safeParse(beeColor).success;
    expect(stored('lime')).toBe(true);
    expect(stored('#38BDF8')).toBe(true);
    expect(stored(null)).toBe(true);
    expect(stored('#38BDF')).toBe(false);
    expect(stored('blue')).toBe(false);
  });

  it('converte entre HEX e matiz, saturação e luz sem perder a cor', () => {
    expect(hexToHsl('#FF0000')).toEqual({ h: 0, s: 100, l: 50 });
    expect(hexToHsl('#FFFFFF')).toEqual({ h: 0, s: 0, l: 100 });
    expect(hslToHex({ h: 120, s: 100, l: 50 })).toBe('#00FF00');
    // Through whole-number sliders and back, a colour stays the same to the eye.
    const channels = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
    for (const swatch of beeSwatches) {
      const back = channels(hslToHex(hexToHsl(swatch.hex)));
      channels(swatch.hex).forEach((value, index) =>
        expect(Math.abs(value - back[index]!)).toBeLessThanOrEqual(3),
      );
    }
    // Out of range is clamped, never an invalid colour.
    expect(hslToHex({ h: 400, s: 150, l: -5 })).toMatch(/^#[0-9A-F]{6}$/);
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

describe('catálogo de funções', () => {
  it('toda função tem rótulo, categoria conhecida e lugar único na ordem do catálogo', () => {
    const categories = new Set<string>(roleCategories.map((category) => category.id));
    for (const role of workerRoleSchema.options) {
      expect(roleInfo[role].label).toBeTruthy();
      expect(categories.has(roleInfo[role].category)).toBe(true);
    }
    expect([...roleOrder].sort()).toEqual([...workerRoleSchema.options].sort());
    expect(roleOrder[0]).toBe('queen');
  });

  it('os sete especialistas têm preset próprio, e os de leitura não editam arquivos', () => {
    expect(specialistRoles).toHaveLength(7);
    for (const role of specialistRoles) {
      const preset = rolePresets[role];
      expect(preset.role).toBe(role);
      expect(preset.systemPrompt.length).toBeGreaterThan(200);
      expect(preset.description).toBeTruthy();
      // Never a model or provider fixed in the preset: the user picks them per agent.
      expect(preset).not.toHaveProperty('providerId');
      expect(preset).not.toHaveProperty('modelId');
    }
    for (const role of ['explorer', 'security', 'requirements'] as const) {
      expect(rolePresets[role].tools).not.toContain('write_file');
      expect(rolePresets[role].tools).not.toContain('replace_in_file');
    }
    // Investigation needs to reproduce: the Debug Detective can run commands, with approval.
    expect(rolePresets.debugger.tools).toContain('run_command');
  });
});
