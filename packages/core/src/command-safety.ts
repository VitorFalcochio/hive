import { commandMatchesAllowList } from './state';

/**
 * Commands that only look at things: versions, installed packages, git history, file listings
 * and searches. Matched like allow-list entries (exact, or `prefix *`) against each part of a
 * chained command.
 */
export const readOnlyCommands: readonly string[] = [
  'where *',
  'which *',
  'command -v *',
  'python --version',
  'python -V',
  'python3 --version',
  'python3 -V',
  'py --version',
  'pip --version',
  'pip list *',
  'pip show *',
  'pip freeze',
  'pip3 list *',
  'pip3 show *',
  'python -m pip list *',
  'python -m pip show *',
  'node --version',
  'node -v',
  'npm --version',
  'npm -v',
  'npm ls *',
  'npm list *',
  'npm outdated *',
  'npx --version',
  'pnpm --version',
  'pnpm ls *',
  'pnpm list *',
  'yarn --version',
  'bun --version',
  'deno --version',
  'java -version',
  'go version',
  'rustc --version',
  'cargo --version',
  'dotnet --version',
  'git status *',
  'git diff *',
  'git log *',
  'git show *',
  'git branch',
  'git branch -a',
  'git branch --list *',
  'git rev-parse *',
  'git ls-files *',
  'git remote -v',
  'ls *',
  'dir *',
  'tree *',
  'pwd',
  'cd *',
  'echo *',
  'cat *',
  'type *',
  'head *',
  'tail *',
  'wc *',
  'findstr *',
  'grep *',
  'rg *',
  'Get-ChildItem *',
  'Get-Content *',
  'Get-Location',
  'Select-String *',
  'Test-Path *',
];

/** Discarding output or merging streams writes nothing anywhere, so these redirections are fine. */
const harmlessRedirect = /\s*(?:[12]?>\s*(?:nul|\/dev\/null)|2>&1|1>&2)(?=\s|$)/gi;

/**
 * Splits a command line on `&&`, `||`, `|`, `;` and `&` outside quotes. Returns null when the
 * line cannot be judged: an open quote, or command substitution.
 */
function splitChain(command: string): string[] | null {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    // A line break is another command, even inside quotes for some shells: never safe.
    if (char === '\n' || char === '\r') return null;
    if (quote) {
      if (char === quote) quote = null;
      else if (quote === '"' && (char === '`' || (char === '$' && command[index + 1] === '(')))
        return null;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '`' || (char === '$' && command[index + 1] === '(')) return null;
    if (char === ';' || char === '|' || char === '&') {
      // `2>&1` is a redirection, not a separator.
      if (char === '&' && command[index - 1] === '>') {
        current += char;
        continue;
      }
      if (command[index + 1] === char) index++;
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (quote) return null;
  parts.push(current);
  return parts.map((part) => part.trim());
}

/** Arguments that reach outside the project: parent folders, absolute paths, the home folder. */
function leavesProject(segment: string): boolean {
  const unquoted = segment.replace(/"[^"]*"|'[^']*'/g, (text) => text.replace(/\s/g, '_'));
  return unquoted
    .split(/\s+/)
    .slice(1)
    .map((arg) => arg.replace(/^["']|["']$/g, ''))
    .some(
      (arg) =>
        arg.includes('..') ||
        /^~/.test(arg) ||
        /^[a-z]:[\\/]/i.test(arg) ||
        /^\\\\/.test(arg) ||
        // Windows flags start with a slash too (`findstr /i`); a path has a second one.
        /^\/[^\s/]*\//.test(arg) ||
        /[$%]/.test(arg),
    );
}

/**
 * Whether a command only reads: every part of a chain is a known read-only command (or one of
 * `extra`, e.g. the shift's check commands), no part writes to a file, and no argument points
 * outside the project.
 */
export function isSafeCommand(command: string, extra: readonly string[] = []): boolean {
  const parts = splitChain(command.trim());
  if (!parts || parts.some((part) => !part)) return false;
  return parts.every((part) => {
    const segment = part.replace(harmlessRedirect, '').trim();
    // Rules match on the command and its flags; quoted text is only data, whatever it contains.
    const shape = segment.replace(/"[^"]*"|'[^']*'/g, '""');
    // Any redirection left writes to or reads from a file.
    if (/[<>]/.test(shape)) return false;
    if (commandMatchesAllowList(shape, extra)) return true;
    return commandMatchesAllowList(shape, readOnlyCommands) && !leavesProject(segment);
  });
}
