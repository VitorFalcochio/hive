import {
  beeColorSchema,
  soldierRoleSchema,
  type BeeColor,
  type BeeColorValue,
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
  /**
   * No longer offered when adding a provider; providers already set up with it keep working.
   * OpenAI's API is left out because ChatGPT (sign-in with the user's plan) covers its models.
   */
  hidden?: boolean;
  defaultBaseUrl: string;
  docsUrl: string;
  /** Where to create an API key. */
  keyUrl: string;
  keyHint: string;
  /** Whether a usable no-cost tier exists, and its catch, in the UI language. */
  free: { available: boolean; summary: string };
  /** Calls work without an API key (a local server, or a gateway with keyless free models). */
  keyOptional?: boolean;
  /**
   * Signs in with an account instead of taking an API key. `chatgpt` is OpenAI's "Sign in with
   * ChatGPT": calls spend the user's ChatGPT plan, not an API balance. `claude-code` uses the
   * sign-in of the Claude Code installed on this computer: its claude.ai plan quota.
   */
  signIn?: 'chatgpt' | 'claude-code';
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
    hidden: true,
  },
  chatgpt: {
    kind: 'chatgpt',
    label: 'ChatGPT',
    defaultBaseUrl: 'https://api.openai.com/v1',
    docsUrl: 'https://developers.openai.com/siwc/token-sharing-open-source',
    // Where the user sees and limits what Hive spends of the plan ("Manage usage").
    keyUrl: 'https://chatgpt.com/settings/usage',
    keyHint: 'Sem chave: entre com a conta do ChatGPT',
    free: {
      available: false,
      summary:
        'Usa a cota do seu plano ChatGPT (Go, Plus ou Pro): sem chave de API e sem cobrança extra. Os pedidos dividem o limite do plano com o Codex; dá para pôr um teto só para o Hive nas configurações de uso do ChatGPT.',
    },
    signIn: 'chatgpt',
  },
  'claude-code': {
    kind: 'claude-code',
    label: 'Claude Code',
    // Not called: Hive talks to the Claude Code CLI installed here, never to an Anthropic API.
    defaultBaseUrl: 'https://claude.ai',
    docsUrl: 'https://docs.claude.com/en/docs/claude-code/cli-reference',
    // Where the user sees what the plan has left.
    keyUrl: 'https://claude.ai/settings/usage',
    keyHint: 'Sem chave: usa o login do seu Claude Code',
    free: {
      available: false,
      summary:
        'Usa a cota do seu plano Claude (Pro ou Max) pelo Claude Code instalado neste computador: sem chave de API e sem cobrança por uso. Só funciona com login pela conta claude.ai; login por chave de API é recusado pela trava de custo.',
    },
    signIn: 'claude-code',
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
  'web_fetch',
  'view_page',
];

export const readOnlyTools: ToolName[] = [
  'list_dir',
  'read_file',
  'search',
  'read_skill_resource',
  'web_fetch',
  'view_page',
];

/**
 * Off in the role presets until the user turns them on: a page read off the web can carry
 * instructions, and the address an agent fetches carries whatever it puts in it.
 */
const optInTools: ToolName[] = ['web_fetch'];
const presetTools = allTools.filter((tool) => !optInTools.includes(tool));
const presetReadOnlyTools = readOnlyTools.filter((tool) => !optInTools.includes(tool));

export const toolDescriptions: Record<ToolName, string> = {
  list_dir: 'List files and folders',
  read_file: 'Read file contents',
  search: 'Search text in the worktree',
  write_file: 'Create or overwrite files',
  replace_in_file: 'Edit files by exact replacement',
  run_command: 'Run shell commands (approval required unless allow-listed)',
  read_skill_resource: 'Read reference files of assigned skills',
  web_fetch: 'Read a web page or API response (GET only)',
  view_page: 'Screenshot a page served on localhost and read its console errors',
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
    tools: presetReadOnlyTools,
    skills: ['planning-and-task-breakdown', 'writing-plans'],
    systemPrompt:
      'You coordinate a team of software agents. Break objectives into small, independently verifiable tasks. Prefer tasks that touch different files so they can run in parallel. Every task needs concrete acceptance criteria.',
  },
  architect: {
    role: 'architect',
    label: 'Software Architect',
    description: 'Designs structure and module boundaries; writes design notes and scaffolding.',
    tools: presetTools,
    skills: [
      'api-and-interface-design',
      'documentation-and-adrs',
      'verification-before-completion',
    ],
    systemPrompt:
      'You are a pragmatic software architect. Keep changes minimal and consistent with the existing structure. Explain trade-offs briefly in your final summary.',
  },
  frontend: {
    role: 'frontend',
    label: 'Frontend Developer',
    description: 'Builds user interfaces and client-side logic.',
    tools: presetTools,
    skills: [
      'frontend-design',
      'frontend-ui-engineering',
      'accessibility-engineering',
      'systematic-debugging',
      'verification-before-completion',
    ],
    systemPrompt:
      'You are a senior frontend engineer. Match the existing component patterns, keep markup accessible, and verify your changes with the project test or build commands when available.',
  },
  backend: {
    role: 'backend',
    label: 'Backend Developer',
    description: 'Implements services, data access and APIs.',
    tools: presetTools,
    skills: [
      'api-and-interface-design',
      'security-and-hardening',
      'performance-optimization',
      'systematic-debugging',
      'verification-before-completion',
    ],
    systemPrompt:
      'You are a senior backend engineer. Validate inputs, handle errors explicitly and keep functions small. Run the relevant tests before finishing.',
  },
  qa: {
    role: 'qa',
    label: 'QA Engineer',
    description: 'Writes and runs tests; reports failures with evidence.',
    tools: presetTools,
    skills: ['test-driven-development', 'systematic-debugging', 'verification-before-completion'],
    systemPrompt:
      'You are a QA engineer. Add focused tests for the behaviour described in the task, run them, and report exact commands and results.',
  },
  reviewer: {
    role: 'reviewer',
    label: 'Code Reviewer',
    description: 'Reviews changes for correctness and risk without editing.',
    tools: presetReadOnlyTools,
    skills: ['code-review-and-quality', 'code-simplification', 'security-and-hardening'],
    systemPrompt:
      'You are a careful code reviewer. Read the relevant code, identify concrete defects with file and line references, and do not modify files.',
  },
  explorer: {
    role: 'explorer',
    label: 'Codebase Explorer',
    description:
      'Maps the repository before work starts: structure, technologies, relevant files and integration points. Read-only.',
    tools: presetReadOnlyTools,
    skills: ['documentation-and-adrs', 'api-and-interface-design'],
    systemPrompt: [
      'You are a codebase explorer. Your job is to understand the repository so others can change it safely. You only read: never create, edit or delete files.',
      'Map the project structure, frameworks and tools, the files and modules relevant to the task, their dependencies, the conventions the code follows and the points where new work should plug in.',
      'Back every claim with evidence: relative file paths, and line numbers or short quotes where they matter. Say when something is a guess.',
      'Finish with a structured report: Summary; Relevant files (path: why it matters); Conventions; Integration points; Risks; Recommendations for whoever implements.',
    ].join('\n\n'),
  },
  debugger: {
    role: 'debugger',
    label: 'Debug Detective',
    description:
      'Investigates failures before anyone fixes them: reproduces the error, finds the cause and proposes a regression test.',
    tools: presetTools,
    skills: ['systematic-debugging', 'test-driven-development', 'verification-before-completion'],
    systemPrompt: [
      'You are a debugging specialist. You find out why something fails; fixing it is usually another agent’s task.',
      'Read the logs and stack traces you are given, reproduce the failure with the smallest command or test you can, and separate the symptom from the cause. Follow the evidence; do not guess.',
      'Do not change production code. You may add a failing test or a small reproduction script that shows the bug; commands you run go through the usual approvals.',
      'Finish with a diagnosis: Symptom; How to reproduce (exact command); Root cause (file and line); Why it happens; Suggested fix; Regression test to add.',
    ].join('\n\n'),
  },
  security: {
    role: 'security',
    label: 'Security Engineer',
    description:
      'Reviews changes for security risks: authentication, secrets, input validation, permissions and vulnerable dependencies.',
    tools: [...presetReadOnlyTools, 'run_command'],
    skills: ['security-and-hardening', 'code-review-and-quality'],
    systemPrompt: [
      'You are a defensive security engineer. Review the code and changes for risks; do not edit files.',
      'Check authentication and authorization, secrets or tokens in code, logs and config, input validation and injection, excessive permissions, unsafe file and command handling, and dependencies with known vulnerabilities (use the project’s own audit command when there is one).',
      'Never run offensive or intrusive tests (scanning, exploitation, brute force) unless the task explicitly says the environment is authorized for it.',
      'Finish with a risk report: for each finding, Severity (critical/high/medium/low), Location (file and line), Evidence, Impact, Recommended fix and a test that would catch it. Say plainly when you found nothing serious.',
    ].join('\n\n'),
  },
  database: {
    role: 'database',
    label: 'Database Engineer',
    description:
      'Designs and improves data structures: schemas, migrations, queries, indexes and rollback plans.',
    tools: presetTools,
    skills: [
      'api-and-interface-design',
      'performance-optimization',
      'verification-before-completion',
    ],
    systemPrompt: [
      'You are a database engineer. Model schemas, write migrations, review queries and indexes, and keep data consistent.',
      'Follow the migration tool and conventions the project already uses. Every migration must be safe to run on existing data, backwards compatible where the app may run old and new code together, and come with a way to roll it back.',
      'Never run a destructive change (dropping tables or columns, deleting or rewriting data) against a real database without the user’s explicit approval in the task; prepare it as a migration and explain the risk instead.',
      'Finish with: what changed in the schema, why, how to apply and roll back, and the checks you ran.',
    ].join('\n\n'),
  },
  performance: {
    role: 'performance',
    label: 'Performance Engineer',
    description:
      'Finds and fixes bottlenecks with measurements: CPU, memory, startup time, slow queries and blocking work.',
    tools: presetTools,
    skills: ['performance-optimization', 'systematic-debugging', 'verification-before-completion'],
    systemPrompt: [
      'You are a performance engineer. You improve speed and resource use based on measurements, never on assumptions.',
      'Measure first: pick a benchmark, profile or timing the project can run, and record the baseline. Look for blocking operations, slow queries, unnecessary work, memory that keeps growing and slow startup.',
      'Change one thing at a time and measure again with the same method. Keep a change only if the numbers improve and the tests still pass.',
      'Finish with a table of before and after for each measurement, the command used, what you changed, and anything you tried that did not help.',
    ].join('\n\n'),
  },
  integration: {
    role: 'integration',
    label: 'Integration Engineer',
    description:
      'Makes the work of several agents fit together: contracts between modules, conflicts and integration tests.',
    tools: presetTools,
    skills: [
      'verification-before-completion',
      'code-review-and-quality',
      'test-driven-development',
    ],
    systemPrompt: [
      'You are an integration engineer. Your worktree already holds the results of the tasks you depend on, merged by Hive. Check that they work together.',
      'Look for mismatched contracts (types, API routes, payloads, events) between frontend and backend or between modules, duplicated or conflicting changes, and broken imports. Run the project’s build and tests, and integration tests where they exist.',
      'Fix small integration problems yourself. For anything larger, describe precisely what each side must change. Do not run git merges, rebases or branch operations yourself: Hive manages branches and worktrees.',
      'Finish with: what was integrated, the problems found and how each was resolved or who should resolve it, and the commands that now pass.',
    ].join('\n\n'),
  },
  requirements: {
    role: 'requirements',
    label: 'Requirements Analyst',
    description:
      'Turns a request into clear, verifiable requirements and acceptance criteria, and points out what is ambiguous.',
    tools: presetReadOnlyTools,
    skills: ['planning-and-task-breakdown', 'writing-plans', 'documentation-and-adrs'],
    systemPrompt: [
      'You are a requirements analyst. Turn the request into requirements others can build and verify. You do not write code or edit files.',
      'Identify functional and non-functional requirements, write user stories and concrete, testable acceptance criteria, and suggest how the work could be split. Read the project where it helps you understand what already exists.',
      'Never invent an important decision the request leaves open. List it under Open questions, with the options and what each would mean.',
      'Finish with: Goal; Requirements (functional, non-functional); User stories; Acceptance criteria; Suggested breakdown; Risks; Open questions.',
    ].join('\n\n'),
  },
  custom: {
    role: 'custom',
    label: 'Custom',
    description: 'A worker with a custom role.',
    tools: presetTools,
    skills: [],
    systemPrompt: '',
  },
};

/**
 * Groups of roles for the agent catalog. Extensible: a new role names its group in `roleInfo`,
 * and a new group only needs an entry here.
 */
export const roleCategories = [
  { id: 'coordination', label: 'Coordenação' },
  { id: 'architecture', label: 'Arquitetura' },
  { id: 'development', label: 'Desenvolvimento' },
  { id: 'analysis', label: 'Exploração e análise' },
  { id: 'quality', label: 'Qualidade e testes' },
  { id: 'security', label: 'Segurança' },
  { id: 'infrastructure', label: 'Infraestrutura e performance' },
  { id: 'integration', label: 'Integração' },
  { id: 'custom', label: 'Personalizados' },
] as const;
export type RoleCategory = (typeof roleCategories)[number]['id'];

/** How each role is shown: a short name in Portuguese and its group. */
export const roleInfo: Record<WorkerRole, { label: string; category: RoleCategory }> = {
  queen: { label: 'Coordenação', category: 'coordination' },
  architect: { label: 'Arquitetura', category: 'architecture' },
  frontend: { label: 'Frontend', category: 'development' },
  backend: { label: 'Backend', category: 'development' },
  explorer: { label: 'Exploração', category: 'analysis' },
  requirements: { label: 'Requisitos', category: 'analysis' },
  qa: { label: 'Testes', category: 'quality' },
  reviewer: { label: 'Revisão', category: 'quality' },
  debugger: { label: 'Depuração', category: 'quality' },
  security: { label: 'Segurança', category: 'security' },
  database: { label: 'Banco de dados', category: 'infrastructure' },
  performance: { label: 'Performance', category: 'infrastructure' },
  integration: { label: 'Integração', category: 'integration' },
  custom: { label: 'Personalizado', category: 'custom' },
};

/** Roles in catalog order: by group, then as listed in `roleInfo`. */
export const roleOrder: WorkerRole[] = roleCategories.flatMap((category) =>
  (Object.keys(roleInfo) as WorkerRole[]).filter((role) => roleInfo[role].category === category.id),
);

/** The specialists Hive added in 0.3: installed once on existing installs (see the service). */
export const specialistRoles: WorkerRole[] = [
  'explorer',
  'debugger',
  'security',
  'database',
  'performance',
  'integration',
  'requirements',
];

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

/** A colour of the bee palette. */
export interface BeeSwatch {
  hex: string;
  label: string;
}

/** The colours offered for bees, by family. Any other colour can be typed as HEX. */
export const beeSwatchFamilies: { label: string; swatches: BeeSwatch[] }[] = [
  {
    label: 'Vermelhos e rosas',
    swatches: [
      { hex: '#EF4444', label: 'Vermelho coral' },
      { hex: '#DC2626', label: 'Vermelho vibrante' },
      { hex: '#EC4899', label: 'Rosa' },
      { hex: '#F472B6', label: 'Rosa-claro' },
    ],
  },
  {
    label: 'Laranjas e amarelos',
    swatches: [
      { hex: '#F97316', label: 'Laranja' },
      { hex: '#F59E0B', label: 'Âmbar' },
      { hex: '#EAB308', label: 'Amarelo' },
      { hex: '#D4A017', label: 'Dourado' },
    ],
  },
  {
    label: 'Verdes',
    swatches: [
      { hex: '#10B981', label: 'Verde-esmeralda' },
      { hex: '#22C55E', label: 'Verde' },
      { hex: '#84CC16', label: 'Verde-lima' },
      { hex: '#2DD4BF', label: 'Verde-menta' },
    ],
  },
  {
    label: 'Azuis e cianos',
    swatches: [
      { hex: '#06B6D4', label: 'Ciano' },
      { hex: '#38BDF8', label: 'Azul-celeste' },
      { hex: '#3B82F6', label: 'Azul' },
      { hex: '#2563EB', label: 'Azul-profundo' },
    ],
  },
  {
    label: 'Roxos e violetas',
    swatches: [
      { hex: '#8B5CF6', label: 'Violeta' },
      { hex: '#A855F7', label: 'Roxo' },
      { hex: '#6366F1', label: 'Índigo' },
      { hex: '#C084FC', label: 'Lilás' },
    ],
  },
  {
    label: 'Neutros e especiais',
    swatches: [
      { hex: '#FFFFFF', label: 'Branco' },
      { hex: '#94A3B8', label: 'Cinza' },
      { hex: '#475569', label: 'Grafite' },
      { hex: '#14B8A6', label: 'Turquesa' },
    ],
  },
];
export const beeSwatches: BeeSwatch[] = beeSwatchFamilies.flatMap((family) => family.swatches);

/** The colour each role's bee wears unless the user picks one. */
const roleBeeColors: Record<Exclude<WorkerRole, 'custom'>, BeeColorValue> = {
  queen: 'gold',
  architect: 'violet',
  frontend: 'cyan',
  backend: 'orange',
  qa: 'lime',
  reviewer: 'fuchsia',
  explorer: '#38BDF8',
  debugger: '#EF4444',
  security: '#EC4899',
  database: '#10B981',
  performance: '#F59E0B',
  integration: '#6366F1',
  requirements: '#C084FC',
};

/** `#RRGGBB` of a stored colour: a named colour of earlier versions, or a HEX value. */
export function beeHex(color: BeeColorValue): string {
  return color in beeColors ? beeColors[color as BeeColor].hex.toUpperCase() : color.toUpperCase();
}

/**
 * The colour an agent wears when none is picked: its role's. Custom agents get a stable colour
 * from their id, never the Queen's gold.
 */
export function defaultBeeColor(worker: Pick<Worker, 'id' | 'role'>): string {
  if (worker.role !== 'custom') return beeHex(roleBeeColors[worker.role]);
  const choices = beeColorSchema.options.filter((color) => color !== 'gold');
  let hash = 0;
  for (const char of worker.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return beeHex(choices[hash % choices.length]!);
}

/** `#RRGGBB` an agent's bee is drawn in: the one picked for it, else its role's. */
export function beeColorOf(worker: Pick<Worker, 'id' | 'role' | 'beeColor'>): string {
  return worker.beeColor ? beeHex(worker.beeColor) : defaultBeeColor(worker);
}

/** The name of a colour: the palette's or an earlier version's, else "Personalizada". */
export function beeColorName(hex: string): string {
  const value = hex.toUpperCase();
  return (
    beeSwatches.find((swatch) => swatch.hex === value)?.label ??
    Object.values(beeColors).find((color) => color.hex.toUpperCase() === value)?.label ??
    'Personalizada'
  );
}

/** The colour for a new custom agent: a palette colour no agent wears yet, else the least worn. */
export function nextBeeColor(workers: Pick<Worker, 'id' | 'role' | 'beeColor'>[]): string {
  const worn = new Map<string, number>();
  for (const worker of workers) {
    const color = beeColorOf(worker);
    worn.set(color, (worn.get(color) ?? 0) + 1);
  }
  // Gold stays the Queen's; white and graphite read poorly as a body colour on their own.
  const choices = beeSwatches
    .map((swatch) => swatch.hex)
    .filter((hex) => !['#D4A017', '#EAB308', '#FFFFFF', '#475569'].includes(hex));
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
    brief:
      'runs tests, builds and other commands, looks at local pages when allowed, and reports exact results.',
    tools: [...lookTools, 'run_command', 'view_page'],
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
      'digs up missing information: docs, APIs, config and usage examples, in the project or on the web when allowed. Read-only.',
    tools: [...lookTools, 'web_fetch'],
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
  // Reading and judging code, like a reviewer; making changes, like a coder; planning.
  explorer: 'reviewer',
  security: 'reviewer',
  debugger: 'coder',
  database: 'coder',
  performance: 'coder',
  integration: 'coder',
  requirements: 'planner',
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
  // The plan's catalog changes with the account; prefixes pick the newest family it offers.
  chatgpt: {
    planner: ['gpt-6', 'gpt-5.5', 'gpt-5'],
    coder: ['codex', 'gpt-6', 'gpt-5.5', 'gpt-5'],
    reviewer: ['gpt-6', 'gpt-5.5', 'gpt-5-mini', 'gpt-5'],
  },
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

/** The providers offered when adding one, in display order. */
export const selectablePresets: ProviderPreset[] = Object.values(providerPresets).filter(
  (preset) => !preset.hidden,
);
