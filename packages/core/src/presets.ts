import type { ProviderKind, ToolName, WorkerRole } from './domain';

export interface ProviderPreset {
  kind: ProviderKind;
  label: string;
  defaultBaseUrl: string;
  docsUrl: string;
  keyHint: string;
}

/**
 * All initial providers expose an OpenAI-compatible Chat Completions API, which is what the
 * built-in runtime speaks. The base URLs come from each provider's public API documentation.
 */
export const providerPresets: Record<ProviderKind, ProviderPreset> = {
  openai: {
    kind: 'openai',
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    docsUrl: 'https://platform.openai.com/docs/api-reference',
    keyHint: 'sk-…',
  },
  groq: {
    kind: 'groq',
    label: 'Groq',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    docsUrl: 'https://console.groq.com/docs/openai',
    keyHint: 'gsk_…',
  },
  nvidia: {
    kind: 'nvidia',
    label: 'NVIDIA',
    defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
    docsUrl: 'https://docs.api.nvidia.com/nim/reference',
    keyHint: 'nvapi-…',
  },
  deepseek: {
    kind: 'deepseek',
    label: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    docsUrl: 'https://api-docs.deepseek.com',
    keyHint: 'sk-…',
  },
  openrouter: {
    kind: 'openrouter',
    label: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    docsUrl: 'https://openrouter.ai/docs',
    keyHint: 'sk-or-…',
  },
  'openai-compatible': {
    kind: 'openai-compatible',
    label: 'OpenAI-compatible',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
    keyHint: 'optional for local servers',
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
  systemPrompt: string;
}

export const rolePresets: Record<WorkerRole, RolePreset> = {
  queen: {
    role: 'queen',
    label: 'Queen · Coordinator',
    description: 'Decomposes missions into tasks with dependencies and acceptance criteria.',
    tools: readOnlyTools,
    systemPrompt:
      'You coordinate a team of software agents. Break objectives into small, independently verifiable tasks. Prefer tasks that touch different files so they can run in parallel. Every task needs concrete acceptance criteria.',
  },
  architect: {
    role: 'architect',
    label: 'Software Architect',
    description: 'Designs structure and module boundaries; writes design notes and scaffolding.',
    tools: allTools,
    systemPrompt:
      'You are a pragmatic software architect. Keep changes minimal and consistent with the existing structure. Explain trade-offs briefly in your final summary.',
  },
  frontend: {
    role: 'frontend',
    label: 'Frontend Developer',
    description: 'Builds user interfaces and client-side logic.',
    tools: allTools,
    systemPrompt:
      'You are a senior frontend engineer. Match the existing component patterns, keep markup accessible, and verify your changes with the project test or build commands when available.',
  },
  backend: {
    role: 'backend',
    label: 'Backend Developer',
    description: 'Implements services, data access and APIs.',
    tools: allTools,
    systemPrompt:
      'You are a senior backend engineer. Validate inputs, handle errors explicitly and keep functions small. Run the relevant tests before finishing.',
  },
  qa: {
    role: 'qa',
    label: 'QA Engineer',
    description: 'Writes and runs tests; reports failures with evidence.',
    tools: allTools,
    systemPrompt:
      'You are a QA engineer. Add focused tests for the behaviour described in the task, run them, and report exact commands and results.',
  },
  reviewer: {
    role: 'reviewer',
    label: 'Code Reviewer',
    description: 'Reviews changes for correctness and risk without editing.',
    tools: readOnlyTools,
    systemPrompt:
      'You are a careful code reviewer. Read the relevant code, identify concrete defects with file and line references, and do not modify files.',
  },
  custom: {
    role: 'custom',
    label: 'Custom',
    description: 'A worker with a custom role.',
    tools: allTools,
    systemPrompt: '',
  },
};
