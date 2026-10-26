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
  return /\b(test|tests|vitest|jest|pytest|mocha|ava|tap|go test|cargo test|dotnet test|phpunit|rspec|tsc|lint|eslint|check)\b/i.test(
    command,
  );
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
