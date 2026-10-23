import {
  beeColorSchema,
  soldierRoleSchema,
  type BeeColor,
  type ProviderKind,
  type Soldier,
  type SoldierRole,
  type ToolName,
  type Worker,
  type WorkerRole,
} from './domain';

export interface ProviderPreset {
  kind: ProviderKind;
  label: string;
  defaultBaseUrl: string;
  docsUrl: string;
  /** Where to create an API key. */
  keyUrl: string;
  keyHint: string;
  /** Whether a usable no-cost tier exists, and its catch, in the UI language. */
  free: { available: boolean; summary: string };
  /** Calls work without an API key (a local server, or a gateway with keyless free models). */
  keyOptional?: boolean;
}

/**
 * Every provider exposes an OpenAI-compatible Chat Completions API, which is what the built-in
 * runtime speaks. Free-tier summaries change often; they are hints, not guarantees.
 */
export const providerPresets: Record<ProviderKind, ProviderPreset> = {
  groq: {
    kind: 'groq',
    label: 'Groq',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    docsUrl: 'https://console.groq.com/docs/openai',
    keyUrl: 'https://console.groq.com/keys',
    keyHint: 'gsk_…',
    free: {
      available: true,
      summary:
        'Grátis sem cartão. Muito rápido; cerca de 1.000 pedidos por dia e limite de tokens por minuto.',
    },
  },
  nvidia: {
    kind: 'nvidia',
    label: 'NVIDIA',
    defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
    docsUrl: 'https://docs.api.nvidia.com/nim/reference',
    keyUrl: 'https://build.nvidia.com/settings/api-keys',
    keyHint: 'nvapi-…',
    free: {
      available: true,
      summary:
        'Grátis para desenvolvimento, cerca de 40 pedidos por minuto. Muitos modelos; alguns listados já foram desativados.',
    },
  },
  gemini: {
    kind: 'gemini',
    label: 'Google Gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHint: 'AIza…',
    free: {
      available: true,
      summary:
        'Grátis sem cartão nos modelos Flash. No plano grátis o Google pode usar os pedidos para melhorar os produtos dele.',
    },
  },
  cerebras: {
    kind: 'cerebras',
    label: 'Cerebras',
    defaultBaseUrl: 'https://api.cerebras.ai/v1',
    docsUrl: 'https://inference-docs.cerebras.ai',
    keyUrl: 'https://cloud.cerebras.ai',
    keyHint: 'csk-…',
    free: {
      available: true,
      summary:
        'Extremamente rápido. Plano grátis com limite diário de tokens e contexto menor; as regras mudam com frequência.',
    },
  },
  mistral: {
    kind: 'mistral',
    label: 'Mistral',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    docsUrl: 'https://docs.mistral.ai/api',
    keyUrl: 'https://console.mistral.ai/api-keys',
    keyHint: 'Chave da Mistral',
    free: {
      available: true,
      summary:
        'Plano Experiment grátis (verificação por telefone), inclui Codestral. Cerca de 1 pedido por segundo.',
    },
  },
  kilo: {
    kind: 'kilo',
    label: 'Kilo Gateway',
    defaultBaseUrl: 'https://api.kilo.ai/api/gateway',
    docsUrl: 'https://kilo.ai/docs/gateway',
    keyUrl: 'https://app.kilo.ai',
    keyHint: 'Opcional para os modelos grátis',
    free: {
      available: true,
      summary:
        'Modelos ":free" sem chave e sem cartão; o provedor pode registrar os prompts. Com uma chave, 400+ modelos pagos a preço de custo. O Hive prioriza os gratuitos.',
    },
    keyOptional: true,
  },
  openrouter: {
    kind: 'openrouter',
    label: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    docsUrl: 'https://openrouter.ai/docs',
    keyUrl: 'https://openrouter.ai/settings/keys',
    keyHint: 'sk-or-…',
    free: {
      available: true,
      summary:
        'Modelos ":free" sem custo, cerca de 50 pedidos por dia (1.000 após comprar US$ 10 em créditos). O Hive prioriza os gratuitos.',
    },
  },
  deepseek: {
    kind: 'deepseek',
    label: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    docsUrl: 'https://api-docs.deepseek.com',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    keyHint: 'sk-…',
    free: { available: false, summary: 'Pago, mas barato.' },
  },
  openai: {
    kind: 'openai',
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    docsUrl: 'https://platform.openai.com/docs/api-reference',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'sk-…',
    free: { available: false, summary: 'Pago.' },
  },
  'openai-compatible': {
    kind: 'openai-compatible',
    label: 'Servidor local (Ollama, LM Studio)',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
    keyUrl: 'https://ollama.com/download',
    keyHint: 'Opcional em servidores locais',
    keyOptional: true,
    free: {
      available: true,
      summary:
        'Sem custo e sem limites, roda no seu computador. Modelos bons de código exigem uma GPU forte.',
    },
  },
};

export const allTools: ToolName[] = [
  'list_dir',
  'read_file',
  'search',
  'write_file',
  'replace_in_file',
  'run_command',
  'read_skill_resource',
];

export const readOnlyTools: ToolName[] = ['list_dir', 'read_file', 'search', 'read_skill_resource'];

export const toolDescriptions: Record<ToolName, string> = {
  list_dir: 'List files and folders',
  read_file: 'Read file contents',
  search: 'Search text in the worktree',
  write_file: 'Create or overwrite files',
  replace_in_file: 'Edit files by exact replacement',
  run_command: 'Run shell commands (approval required unless allow-listed)',
  read_skill_resource: 'Read reference files of assigned skills',
};

export interface RolePreset {
  role: WorkerRole;
  label: string;
  description: string;
  tools: ToolName[];
  /** Hive's built-in skills this role starts with. */
  skills: string[];
  systemPrompt: string;
}

export const rolePresets: Record<WorkerRole, RolePreset> = {
  queen: {
    role: 'queen',
    label: 'Queen · Coordinator',
    description: 'Decomposes missions into tasks with dependencies and acceptance criteria.',
    tools: readOnlyTools,
    skills: ['planejar-tarefas'],
    systemPrompt:
      'You coordinate a team of software agents. Break objectives into small, independently verifiable tasks. Prefer tasks that touch different files so they can run in parallel. Every task needs concrete acceptance criteria.',
  },
  architect: {
    role: 'architect',
    label: 'Software Architect',
    description: 'Designs structure and module boundaries; writes design notes and scaffolding.',
    tools: allTools,
    skills: ['decisoes-de-arquitetura', 'verificar-antes-de-concluir'],
    systemPrompt:
      'You are a pragmatic software architect. Keep changes minimal and consistent with the existing structure. Explain trade-offs briefly in your final summary.',
  },
  frontend: {
    role: 'frontend',
    label: 'Frontend Developer',
    description: 'Builds user interfaces and client-side logic.',
    tools: allTools,
    skills: ['interface-de-qualidade', 'depurar-sistematicamente', 'verificar-antes-de-concluir'],
    systemPrompt:
      'You are a senior frontend engineer. Match the existing component patterns, keep markup accessible, and verify your changes with the project test or build commands when available.',
  },
  backend: {
    role: 'backend',
    label: 'Backend Developer',
    description: 'Implements services, data access and APIs.',
    tools: allTools,
    skills: [
      'apis-e-dados',
      'seguranca-no-codigo',
      'depurar-sistematicamente',
      'verificar-antes-de-concluir',
    ],
    systemPrompt:
      'You are a senior backend engineer. Validate inputs, handle errors explicitly and keep functions small. Run the relevant tests before finishing.',
  },
  qa: {
    role: 'qa',
    label: 'QA Engineer',
    description: 'Writes and runs tests; reports failures with evidence.',
    tools: allTools,
    skills: ['escrever-testes', 'depurar-sistematicamente', 'verificar-antes-de-concluir'],
    systemPrompt:
      'You are a QA engineer. Add focused tests for the behaviour described in the task, run them, and report exact commands and results.',
  },
  reviewer: {
    role: 'reviewer',
    label: 'Code Reviewer',
    description: 'Reviews changes for correctness and risk without editing.',
    tools: readOnlyTools,
    skills: ['revisar-codigo', 'seguranca-no-codigo'],
    systemPrompt:
      'You are a careful code reviewer. Read the relevant code, identify concrete defects with file and line references, and do not modify files.',
  },
  custom: {
    role: 'custom',
    label: 'Custom',
    description: 'A worker with a custom role.',
    tools: allTools,
    skills: [],
    systemPrompt: '',
  },
};

export const beeColors: Record<BeeColor, { label: string; hex: string }> = {
  gold: { label: 'Dourada', hex: '#f5b544' },
  orange: { label: 'Laranja', hex: '#f97316' },
  lime: { label: 'Lima', hex: '#a3e635' },
  cyan: { label: 'Ciano', hex: '#22d3ee' },
  violet: { label: 'Violeta', hex: '#a78bfa' },
  fuchsia: { label: 'Fúcsia', hex: '#e879f9' },
  indigo: { label: 'Índigo', hex: '#818cf8' },
  silver: { label: 'Prata', hex: '#cbd5e1' },
};

const roleBeeColors: Record<Exclude<WorkerRole, 'custom'>, BeeColor> = {
  queen: 'gold',
  architect: 'violet',
  frontend: 'cyan',
  backend: 'orange',
  qa: 'lime',
  reviewer: 'fuchsia',
};

/**
 * The colour an agent's bee is drawn in: the one picked for it, else its role's. Custom agents
 * without a pick get a stable colour from their id, never the Queen's gold.
 */
export function beeColorOf(worker: Pick<Worker, 'id' | 'role' | 'beeColor'>): BeeColor {
  if (worker.beeColor) return worker.beeColor;
  if (worker.role !== 'custom') return roleBeeColors[worker.role];
  const choices = beeColorSchema.options.filter((color) => color !== 'gold');
  let hash = 0;
  for (const char of worker.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return choices[hash % choices.length]!;
}

/** The colour for a new custom agent: one no agent wears yet, else the least worn. */
export function nextBeeColor(workers: Pick<Worker, 'id' | 'role' | 'beeColor'>[]): BeeColor {
  const worn = new Map<BeeColor, number>();
  for (const worker of workers) {
    const color = beeColorOf(worker);
    worn.set(color, (worn.get(color) ?? 0) + 1);
  }
  const choices = beeColorSchema.options.filter((color) => color !== 'gold');
  return choices.reduce((best, color) =>
    (worn.get(color) ?? 0) < (worn.get(best) ?? 0) ? color : best,
  );
}

/** The squad in the order the captain usually calls on it. */
export const soldierRoles: SoldierRole[] = soldierRoleSchema.options;

export interface SoldierPreset {
  label: string;
  detail: string;
  /** What she is for, told to the captain and to her in English. */
  brief: string;
  /** Her tools at most; she never gets one her captain lacks. */
  tools: ToolName[];
}

const lookTools: ToolName[] = ['list_dir', 'read_file', 'search'];

export const soldierPresets: Record<SoldierRole, SoldierPreset> = {
  scout: {
    label: 'Batedora',
    detail: 'Explora o projeto e acha onde mexer. Só lê.',
    brief: 'explores the project and finds the files and code that matter. Read-only.',
    tools: lookTools,
  },
  builder: {
    label: 'Operária',
    detail: 'Escreve e edita o código.',
    brief: 'writes and edits code following precise instructions.',
    tools: [...lookTools, 'write_file', 'replace_in_file'],
  },
  tester: {
    label: 'Testadora',
    detail: 'Roda testes e comandos para conferir o trabalho.',
    brief: 'runs tests, builds and other commands, and reports exact results.',
    tools: [...lookTools, 'run_command'],
  },
  reviewer: {
    label: 'Revisora',
    detail: 'Revisa o que mudou antes da entrega. Só lê.',
    brief: 'reviews changed code for defects and risks. Read-only.',
    tools: lookTools,
  },
  researcher: {
    label: 'Pesquisadora',
    detail: 'Entra quando falta informação: documentação, APIs, exemplos.',
    brief:
      'digs up missing information in the project: docs, APIs, config, usage examples. Read-only.',
    tools: lookTools,
  },
};

/** Soldiers that change the worktree; two of them never work at the same time. */
export function soldierWrites(role: SoldierRole): boolean {
  return soldierPresets[role].tools.some((tool) => !readOnlyTools.includes(tool));
}

/**
 * The soldiers a captain can call: enabled ones left with at least one tool once her own tools
 * cap theirs.
 */
export function callableSoldiers(
  worker: Pick<Worker, 'role' | 'squad' | 'tools'>,
): { soldier: Soldier; tools: ToolName[] }[] {
  return squadOf(worker)
    .filter((soldier) => soldier.enabled)
    .map((soldier) => ({
      soldier,
      tools: soldierPresets[soldier.role].tools.filter((tool) => worker.tools.includes(tool)),
    }))
    .filter(({ tools }) => tools.length > 0);
}

/**
 * The agent as it works a task given honey: twice the steps, tokens and time (up to what Hive
 * allows) and every soldier of its squad called in, whatever was switched off.
 */
export function honeyBoost<T extends Pick<Worker, 'role' | 'squad' | 'limits'>>(worker: T): T {
  const { limits } = worker;
  return {
    ...worker,
    squad: squadOf(worker).map((soldier) => ({ ...soldier, enabled: true })),
    limits: {
      ...limits,
      maxSteps: Math.min(200, limits.maxSteps * 2),
      maxTokens: Math.min(10_000_000, limits.maxTokens * 2),
      taskTimeoutMin: Math.min(600, limits.taskTimeoutMin * 2),
    },
  };
}

/** An agent's whole squad, defaults filled in, in `soldierRoles` order. The Queen has none. */
export function squadOf(worker: Pick<Worker, 'role' | 'squad'>): Soldier[] {
  if (worker.role === 'queen') return [];
  return soldierRoles.map(
    (role) =>
      worker.squad?.find((soldier) => soldier.role === role) ?? {
        role,
        enabled: true,
        modelId: null,
      },
  );
}

/** Which kind of work a role does, used to pick a suitable model. */
type ModelTier = 'planner' | 'coder' | 'reviewer';
const roleTiers: Record<WorkerRole, ModelTier> = {
  queen: 'planner',
  architect: 'planner',
  frontend: 'coder',
  backend: 'coder',
  qa: 'coder',
  reviewer: 'reviewer',
  custom: 'coder',
};

/**
 * Ordered model preferences per provider and tier. Entries are matched against the provider's
 * live catalog (exact id first, then substring), and the caller must still test the pick:
 * providers keep retired models in `GET /models` long after calls start returning 404.
 */
const genericPreferences: Record<ModelTier, string[]> = {
  planner: [
    'kimi-k2',
    'glm-5',
    'deepseek-v4',
    'gpt-5',
    'gpt-oss-120b',
    'qwen3',
    'llama-3.3-70b',
    'deepseek-chat',
    'gpt-4.1',
    'gpt-oss-20b',
  ],
  coder: [
    'glm-5',
    'kimi-k2',
    'qwen3-coder',
    'deepseek-v4',
    'gpt-5',
    'gpt-oss-120b',
    'llama-3.3-70b',
    'deepseek-chat',
    'gpt-4.1',
    'gpt-oss-20b',
  ],
  reviewer: [
    'deepseek-v4',
    'glm-5',
    'gpt-5-mini',
    'gpt-oss-120b',
    'kimi-k2',
    'llama-3.3-70b',
    'deepseek-chat',
    'gpt-4.1-mini',
    'gpt-oss-20b',
  ],
};
const modelPreferences: Partial<Record<ProviderKind, Record<ModelTier, string[]>>> = {
  groq: {
    planner: ['openai/gpt-oss-120b', 'moonshotai/kimi-k2', 'qwen/qwen3-32b', 'llama-3.3-70b'],
    coder: ['moonshotai/kimi-k2', 'openai/gpt-oss-120b', 'qwen/qwen3-32b', 'llama-3.3-70b'],
    reviewer: ['openai/gpt-oss-120b', 'qwen/qwen3-32b', 'openai/gpt-oss-20b', 'llama-3.3-70b'],
  },
  // The free tier is Flash-only; Pro answers 429 there and is skipped by the test call.
  gemini: {
    planner: ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    coder: ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    reviewer: ['gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'],
  },
  cerebras: {
    planner: ['gpt-oss-120b', 'zai-glm', 'qwen-3-235b', 'llama-3.3-70b', 'qwen-3-32b'],
    coder: ['zai-glm', 'qwen-3-coder', 'gpt-oss-120b', 'qwen-3-235b', 'qwen-3-32b'],
    reviewer: ['gpt-oss-120b', 'qwen-3-235b', 'qwen-3-32b', 'llama-3.3-70b'],
  },
  mistral: {
    planner: [
      'mistral-medium-latest',
      'mistral-large-latest',
      'magistral-medium',
      'devstral-medium',
    ],
    coder: ['devstral-medium', 'codestral-latest', 'devstral-small', 'mistral-medium-latest'],
    reviewer: [
      'mistral-small-latest',
      'codestral-latest',
      'devstral-small',
      'mistral-medium-latest',
    ],
  },
  kilo: {
    planner: [
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'minimax/minimax-m3.1-flash:free',
      'nvidia/nemotron-3-super-120b-a12b:free',
      'kilo-auto/free',
    ],
    coder: [
      'minimax/minimax-m3.1-flash:free',
      'poolside/laguna-s-2.1:free',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'kilo-auto/free',
    ],
    reviewer: [
      'nvidia/nemotron-3-super-120b-a12b:free',
      'minimax/minimax-m3.1-flash:free',
      'cohere/north-mini-code:free',
      'kilo-auto/free',
    ],
  },
  openrouter: {
    planner: ['gpt-oss-120b', 'kimi-k2', 'glm-4.5-air', 'qwen3-235b', 'deepseek'],
    coder: ['qwen3-coder', 'kimi-k2', 'gpt-oss-120b', 'glm-4.5-air', 'devstral'],
    reviewer: ['gpt-oss-120b', 'qwen3-coder', 'glm-4.5-air', 'mistral-small'],
  },
  nvidia: {
    planner: [
      'moonshotai/kimi-k2.6',
      'z-ai/glm-5.3',
      'nvidia/nemotron-3-super-120b-a12b',
      'deepseek-ai/deepseek-v4.1-flash',
      'openai/gpt-oss-20b',
    ],
    coder: [
      'z-ai/glm-5.3',
      'moonshotai/kimi-k2.6',
      'deepseek-ai/deepseek-v4.1-flash',
      'nvidia/nemotron-3-super-120b-a12b',
      'openai/gpt-oss-20b',
    ],
    reviewer: [
      'deepseek-ai/deepseek-v4.1-flash',
      'z-ai/glm-5.3-flash',
      'z-ai/glm-5.3',
      'nvidia/nemotron-3-super-120b-a12b',
      'openai/gpt-oss-20b',
    ],
  },
};

/**
 * Catalog ids worth trying for a role, best first. `preferred` ids (e.g. the free models of a
 * provider that publishes pricing) are all tried before any other model; within each group the
 * order follows the role preferences. Empty when nothing in the catalog fits.
 */
export function recommendedModelCandidates(
  kind: ProviderKind,
  role: WorkerRole,
  catalogIds: string[],
  preferred: string[] = [],
): string[] {
  const tier = roleTiers[role];
  const preferences = [...(modelPreferences[kind]?.[tier] ?? []), ...genericPreferences[tier]];
  const rank = (ids: string[]) => {
    const picked: string[] = [];
    for (const preference of preferences) {
      const wanted = preference.toLowerCase();
      const match =
        ids.find((id) => id.toLowerCase() === wanted) ??
        ids.find((id) => id.toLowerCase().includes(wanted));
      if (match && !picked.includes(match)) picked.push(match);
    }
    return picked;
  };
  const favourites = rank(preferred);
  // Preferred models outside the known list still beat paid ones, up to a few attempts.
  const picked = [...favourites, ...preferred.filter((id) => !favourites.includes(id)).slice(0, 3)];
  for (const id of rank(catalogIds)) if (!picked.includes(id)) picked.push(id);
  return picked;
}
