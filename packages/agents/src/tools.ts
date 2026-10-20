import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { commandMatchesAllowList, type CommandEvidence, type ToolName, type Worker } from '@hive/core';
import type { ToolDefinition } from '@hive/providers';
import type { ResolvedSkill } from '@hive/skills';
import { HiveError, resolveInside, toPosixRelative } from '@hive/shared';
import { runCommand } from './process';
import type { RuntimeEvent } from './runtime';

const MAX_TOOL_OUTPUT = 24_000;
const MAX_READ_BYTES = 512 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', 'build', 'coverage', '.next', '.venv', '__pycache__']);

export interface ToolContext {
  root: string;
  worker: Worker;
  skills: ResolvedSkill[];
  signal: AbortSignal;
  commandTimeoutMs: number;
  requestApproval: (request: { command: string }) => Promise<boolean>;
  emit: (event: RuntimeEvent) => void;
  commands: CommandEvidence[];
}

export interface ToolOutcome {
  output: string;
  isError: boolean;
}

function truncate(text: string, limit = MAX_TOOL_OUTPUT): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, Math.floor(limit * 0.6));
  const tail = text.slice(-Math.floor(limit * 0.35));
  return `${head}\n\n[… ${text.length - head.length - tail.length} characters omitted …]\n\n${tail}`;
}

function str(args: Record<string, unknown>, key: string, required = true): string {
  const value = args[key];
  if (typeof value === 'string') return value;
  if (!required && (value === undefined || value === null)) return '';
  throw new HiveError('VALIDATION', `Argument "${key}" must be a string.`);
}

function guardGit(relative: string): void {
  if (relative.split(/[\\/]/).some((part) => part.toLowerCase() === '.git')) {
    throw new HiveError('FORBIDDEN_PATH', 'Writing inside .git is not allowed.');
  }
}

async function isBinary(file: string): Promise<boolean> {
  const buffer = (await readFile(file)).subarray(0, 8000);
  return buffer.includes(0);
}

export const toolDefinitions: Record<ToolName | 'finish', ToolDefinition> = {
  list_dir: {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and folders. Paths are relative to the project root. Skips .git and node_modules.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory relative to the project root. Default "."' },
          recursive: { type: 'boolean', description: 'List up to 3 levels deep.' },
        },
      },
    },
  },
  read_file: {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file. Optionally pass a 1-based line range.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          start_line: { type: 'integer', minimum: 1 },
          end_line: { type: 'integer', minimum: 1 },
        },
        required: ['path'],
      },
    },
  },
  search: {
    type: 'function',
    function: {
      name: 'search',
      description: 'Search for a literal, case-insensitive string in project files. Returns path:line: text.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, path: { type: 'string', description: 'Directory to search. Default "."' } },
        required: ['query'],
      },
    },
  },
  write_file: {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file with the full content given. Creates parent folders.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  replace_in_file: {
    type: 'function',
    function: {
      name: 'replace_in_file',
      description:
        'Replace an exact snippet in a file. old_string must appear exactly once unless replace_all is true. Include enough surrounding lines to make it unique.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  run_command: {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a shell command in the project root (for example tests or a build). The user may need to approve it. Do not use it to commit, push or modify git history.',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  },
  read_skill_resource: {
    type: 'function',
    function: {
      name: 'read_skill_resource',
      description: 'Read a reference file bundled with one of your assigned skills.',
      parameters: {
        type: 'object',
        properties: { skill: { type: 'string' }, path: { type: 'string' } },
        required: ['skill', 'path'],
      },
    },
  },
  finish: {
    type: 'function',
    function: {
      name: 'finish',
      description:
        'Call exactly once when the task is done (or cannot be done). Summarise what changed, how it was verified, and anything left open.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          success: { type: 'boolean', description: 'false if the task could not be completed.' },
        },
        required: ['summary', 'success'],
      },
    },
  },
};

async function listDir(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const target = await resolveInside(ctx.root, str(args, 'path', false) || '.');
  const recursive = args.recursive === true;
  const lines: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (lines.length >= 400) return;
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (lines.length >= 400) break;
      const full = path.join(dir, entry.name);
      const rel = toPosixRelative(ctx.root, full);
      if (entry.isDirectory()) {
        lines.push(`${rel}/`);
        if (recursive && depth < 2 && !SKIP_DIRS.has(entry.name)) await walk(full, depth + 1);
      } else lines.push(rel);
    }
  };
  await walk(target, 0);
  if (lines.length >= 400) lines.push('[listing truncated at 400 entries]');
  return lines.join('\n') || '(empty directory)';
}

async function readTool(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const file = await resolveInside(ctx.root, str(args, 'path'));
  const info = await lstat(file);
  if (!info.isFile()) throw new HiveError('VALIDATION', 'Not a regular file.');
  if (info.size > MAX_READ_BYTES && args.start_line === undefined) {
    throw new HiveError('LIMIT', `File is ${info.size} bytes; read it with a line range.`);
  }
  if (await isBinary(file)) return '(binary file — not shown)';
  const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
  const start = Math.max(1, Number(args.start_line ?? 1));
  const end = Math.min(lines.length, Number(args.end_line ?? Math.min(lines.length, start + 1999)));
  const body = lines
    .slice(start - 1, end)
    .map((line, index) => `${String(start + index).padStart(5)}  ${line}`)
    .join('\n');
  return `${toPosixRelative(ctx.root, file)} (lines ${start}-${end} of ${lines.length})\n${body}`;
}

async function searchTool(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const query = str(args, 'query').toLowerCase();
  if (!query) throw new HiveError('VALIDATION', 'Query must not be empty.');
  const base = await resolveInside(ctx.root, str(args, 'path', false) || '.');
  const results: string[] = [];
  let scanned = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (results.length >= 100 || scanned > 5000 || ctx.signal.aborted) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
      } else if (entry.isFile()) {
        scanned++;
        const info = await lstat(full);
        if (info.size > 1024 * 1024 || (await isBinary(full))) continue;
        const lines = (await readFile(full, 'utf8')).split(/\r?\n/);
        lines.forEach((line, index) => {
          if (results.length < 100 && line.toLowerCase().includes(query)) {
            results.push(`${toPosixRelative(ctx.root, full)}:${index + 1}: ${line.trim().slice(0, 200)}`);
          }
        });
      }
    }
  };
  await walk(base);
  return results.length ? results.join('\n') + (results.length >= 100 ? '\n[first 100 matches]' : '') : 'No matches.';
}

async function writeTool(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const requested = str(args, 'path');
  guardGit(requested);
  const file = await resolveInside(ctx.root, requested);
  const content = str(args, 'content');
  const existed = await lstat(file).then(() => true, () => false);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
  const rel = toPosixRelative(ctx.root, file);
  ctx.emit({ type: 'file.changed', level: 'info', message: `${existed ? 'Updated' : 'Created'} ${rel}`, data: { path: rel, action: existed ? 'modified' : 'created', bytes: Buffer.byteLength(content) } });
  return `${existed ? 'Updated' : 'Created'} ${rel} (${content.split('\n').length} lines).`;
}

async function replaceTool(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const requested = str(args, 'path');
  guardGit(requested);
  const file = await resolveInside(ctx.root, requested);
  const oldString = str(args, 'old_string');
  const newString = str(args, 'new_string');
  if (!oldString) throw new HiveError('VALIDATION', 'old_string must not be empty. Use write_file to create files.');
  const original = await readFile(file, 'utf8');
  // Models usually send \n; match files that use \r\n too.
  const crlf = original.includes('\r\n') && !oldString.includes('\r\n');
  const needle = crlf ? oldString.replace(/\n/g, '\r\n') : oldString;
  const replacement = crlf ? newString.replace(/\n/g, '\r\n') : newString;
  const count = original.split(needle).length - 1;
  if (count === 0) throw new HiveError('VALIDATION', 'old_string was not found. Read the file again and copy the text exactly.');
  if (count > 1 && args.replace_all !== true) {
    throw new HiveError('VALIDATION', `old_string appears ${count} times. Add surrounding lines to make it unique, or set replace_all.`);
  }
  const updated = args.replace_all === true ? original.split(needle).join(replacement) : original.replace(needle, () => replacement);
  await writeFile(file, updated, 'utf8');
  const rel = toPosixRelative(ctx.root, file);
  ctx.emit({ type: 'file.changed', level: 'info', message: `Edited ${rel}`, data: { path: rel, action: 'modified', replacements: args.replace_all === true ? count : 1 } });
  return `Edited ${rel} (${args.replace_all === true ? count : 1} replacement${count > 1 && args.replace_all === true ? 's' : ''}).`;
}

async function commandTool(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const command = str(args, 'command').trim();
  if (!command) throw new HiveError('VALIDATION', 'Command must not be empty.');
  if (command.length > 2000) throw new HiveError('VALIDATION', 'Command is too long.');
  const autoApproved = commandMatchesAllowList(command, ctx.worker.autoApproveCommands);
  if (!autoApproved) {
    const approved = await ctx.requestApproval({ command });
    if (!approved) return { output: 'The user denied this command. Do not retry it; continue without it or explain in finish.', isError: true };
  }
  ctx.emit({ type: 'command.started', level: 'info', message: command, data: { command, autoApproved } });
  const result = await runCommand(command, { cwd: ctx.root, timeoutMs: ctx.commandTimeoutMs, signal: ctx.signal });
  const tail = result.output.slice(-4000);
  ctx.commands.push({ command, exitCode: result.exitCode, durationMs: result.durationMs, timedOut: result.timedOut, outputTail: tail });
  ctx.emit({
    type: 'command.finished',
    level: result.exitCode === 0 ? 'info' : 'warn',
    message: `${command} → ${result.timedOut ? 'timed out' : result.cancelled ? 'cancelled' : `exit ${result.exitCode}`} (${(result.durationMs / 1000).toFixed(1)}s)`,
    data: { command, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs, outputTail: tail },
  });
  if (result.cancelled) throw new HiveError('CANCELLED', 'Cancelled.');
  const status = result.timedOut ? `timed out after ${Math.round(ctx.commandTimeoutMs / 1000)}s` : `exit code ${result.exitCode}`;
  return { output: `$ ${command}\n(${status})\n${truncate(result.output) || '(no output)'}`, isError: result.exitCode !== 0 };
}

async function skillResourceTool(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const skill = ctx.skills.find((item) => item.name === str(args, 'skill'));
  if (!skill) throw new HiveError('NOT_FOUND', `Skill "${String(args.skill)}" is not assigned to you.`);
  const file = await resolveInside(skill.directory, str(args, 'path'));
  if (await isBinary(file)) return '(binary file — not shown)';
  return readFile(file, 'utf8');
}

/** Execute one tool call. Errors become tool output so the model can recover. */
export async function executeTool(ctx: ToolContext, name: ToolName, args: Record<string, unknown>): Promise<ToolOutcome> {
  try {
    switch (name) {
      case 'list_dir':
        return { output: await listDir(ctx, args), isError: false };
      case 'read_file':
        return { output: truncate(await readTool(ctx, args)), isError: false };
      case 'search':
        return { output: truncate(await searchTool(ctx, args)), isError: false };
      case 'write_file':
        return { output: await writeTool(ctx, args), isError: false };
      case 'replace_in_file':
        return { output: await replaceTool(ctx, args), isError: false };
      case 'run_command':
        return await commandTool(ctx, args);
      case 'read_skill_resource':
        return { output: truncate(await skillResourceTool(ctx, args)), isError: false };
    }
  } catch (error) {
    if (error instanceof HiveError && error.code === 'CANCELLED') throw error;
    if (ctx.signal.aborted) throw new HiveError('CANCELLED', 'Cancelled.');
    const message = error instanceof Error ? error.message : String(error);
    return { output: `Error: ${message.replace(ctx.root, '<root>')}`, isError: true };
  }
}
