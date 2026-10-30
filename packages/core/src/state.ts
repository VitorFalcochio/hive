import type { TaskStatus, ToolName, WorkerState } from './domain';

/**
 * Worker state is derived only from things that actually happened in a session. These helpers
 * keep the mapping in one place so the UI and the runtime agree.
 */
export function stateForTool(tool: ToolName, command?: string): WorkerState {
  switch (tool) {
    case 'write_file':
    case 'replace_in_file':
      return 'coding';
    case 'run_command':
      return command && looksLikeTestCommand(command) ? 'testing' : 'coding';
    case 'view_page':
      return 'testing';
    default:
      return 'thinking';
  }
}

export function looksLikeTestCommand(command: string): boolean {
  // Match an executed check, not a mention of "tests" in echo, grep, filenames or docs.
  const tokens = command.match(/"(?:\\.|[^"\\])*"|'[^']*'|&&|\|\||[;\n|]|[^\s;&|]+/g) ?? [];
  const segments: string[][] = [[]];
  for (const token of tokens) {
    if (/^(?:&&|\|\||[;\n|])$/.test(token)) segments.push([]);
    else segments.at(-1)!.push(token.replace(/^(['"])(.*)\1$/, '$2'));
  }
  const check = /^(?:tests?|lint|typecheck|check)(?::[\w-]+)?$/i;
  const executable = /^(?:vitest|jest|pytest|mocha|ava|tap|phpunit|rspec|tsc|eslint)$/i;
  return segments.some((args) => {
    while (args[0] && /^[\w]+=.*/.test(args[0])) args.shift();
    const program =
      args
        .shift()
        ?.split(/[\\/]/)
        .at(-1)
        ?.replace(/\.(?:cmd|exe)$/i, '') ?? '';
    if (args.some((arg) => arg === '--help' || arg === '--version')) return false;
    if (executable.test(program)) return true;
    if (/^(?:go|cargo|dotnet)$/i.test(program)) return args[0] === 'test';
    if (/^python(?:3(?:\.\d+)?)?$/i.test(program)) return args[0] === '-m' && args[1] === 'pytest';
    if (!/^(?:npm|pnpm|yarn|bun|npx)$/i.test(program)) return false;
    while (args[0]?.startsWith('-')) {
      const option = args.shift();
      if (option && /^(?:--filter|-F|--workspace|-w|--prefix|--dir|-C)$/.test(option)) args.shift();
    }
    if (args[0] === 'run' || args[0] === 'exec' || args[0] === 'x') args.shift();
    return check.test(args[0] ?? '') || executable.test(args[0] ?? '');
  });
}

export function stateForTaskStatus(status: TaskStatus): WorkerState | null {
  switch (status) {
    case 'completed':
    case 'approved':
      return 'completed';
    case 'failed':
    case 'rejected':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'waiting_approval':
      return 'waiting_approval';
    default:
      return null;
  }
}

/** Match a command against an allow-list entry: exact string, or `prefix *`. */
export function commandMatchesAllowList(command: string, allowList: readonly string[]): boolean {
  // A line break starts another command in a shell; it must never ride on an allowed one.
  if (/[\r\n]/.test(command)) return false;
  const normalized = command.trim().replace(/\s+/g, ' ');
  // Never auto-approve command chaining, redirection or substitution.
  if (/[;&|`<>]|\$\(/.test(normalized)) return false;
  return allowList.some((entry) => {
    const rule = entry.trim().replace(/\s+/g, ' ');
    if (rule.endsWith(' *')) {
      const prefix = rule.slice(0, -2);
      return normalized === prefix || normalized.startsWith(`${prefix} `);
    }
    return normalized === rule;
  });
}
