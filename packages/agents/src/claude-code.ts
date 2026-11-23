import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { CommandEvidence } from '@hive/core';
import { Emitter, clipText, errorMessage } from '@hive/shared';
import type { ClaudeCodePermissions, PermissionHandler } from './claude-code-permissions';
import { PERMISSION_TOOL } from './claude-code-permissions';
import { buildTaskPrompt } from './native-runtime';
import { killTree } from './process';
import type {
  AgentOutcome,
  AgentRuntime,
  AgentSession,
  AgentTaskInput,
  RuntimeEvent,
} from './runtime';

/**
 * Claude Code as a Hive engine, through its official non-interactive interface:
 * `claude -p --output-format stream-json`, which prints one JSON message per line (session
 * init, assistant turns with tool calls, tool results, and a final result with usage). No
 * terminal is driven and no free text is parsed.
 *
 * Cost lock: Claude Code bills per call when it signs in with an API key. Sessions only start
 * when `claude auth status` reports a claude.ai sign-in (the user's plan quota), and the
 * environment never carries Anthropic API keys or cloud-billing switches.
 */
export interface ClaudeCodeOptions {
  /** The Claude Code executable; `findClaudeCode()` locates the installed one. */
  executable: string;
  /** Arguments placed before Hive's own, e.g. a script path when `executable` is node. */
  argsPrefix?: string[];
  /**
   * Where Claude Code's permission prompts go: each one becomes a Hive approval, decided by the
   * same rules and screens as Hive's own agents (see ClaudeCodePermissions).
   */
  permissions?: ClaudeCodePermissions;
  /**
   * Without `permissions` (tests, scripts), whether shell commands run freely. Anything that
   * would prompt is refused then, never left waiting.
   */
  allowCommands?: () => boolean;
  /** Lifts the cost lock for API-key sign-ins. Off unless the user chose it explicitly. */
  allowApiBilling?: boolean;
  /** Seconds to wait for `claude auth status`. */
  authTimeoutSec?: number;
}

/** Variables that would make Claude Code bill an API account instead of the user's plan. */
const BILLING_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);

/** Locates the Claude Code executable without a shell; null when it is not installed. */
export function findClaudeCode(env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    if (process.platform !== 'win32') {
      const file = path.join(dir, 'claude');
      if (existsSync(file)) return file;
      continue;
    }
    const exe = path.join(dir, 'claude.exe');
    if (existsSync(exe)) return exe;
    // npm installs a claude.cmd shim next to the package, which holds the native binary.
    if (existsSync(path.join(dir, 'claude.cmd'))) {
      const native = path.join(
        dir,
        'node_modules',
        '@anthropic-ai',
        'claude-code',
        'bin',
        'claude.exe',
      );
      if (existsSync(native)) return native;
    }
  }
  return null;
}

export function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [...BILLING_ENV, 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[name];
  return env;
}

export interface ClaudeCodeAuth {
  loggedIn: boolean;
  authMethod: string | null;
  /** The signed-in account, shown on the provider as ChatGPT's is. */
  email?: string | null;
}

/** `claude auth status`, read as JSON. */
export function claudeCodeAuth(options: ClaudeCodeOptions): Promise<ClaudeCodeAuth> {
  return new Promise((resolve, reject) => {
    execFile(
      options.executable,
      [...(options.argsPrefix ?? []), 'auth', 'status'],
      { env: cleanEnv(), windowsHide: true, timeout: (options.authTimeoutSec ?? 30) * 1000 },
      (error, stdout, stderr) => {
        try {
          const value = JSON.parse(stdout) as {
            loggedIn?: unknown;
            authMethod?: unknown;
            email?: unknown;
          };
          resolve({
            loggedIn: value.loggedIn === true,
            authMethod: typeof value.authMethod === 'string' ? value.authMethod : null,
            email: typeof value.email === 'string' ? value.email : null,
          });
        } catch {
          reject(
            new Error(
              `Não foi possível ler "claude auth status": ${clipText((stderr || stdout || (error ? errorMessage(error) : '')).trim(), 1_000)}`,
            ),
          );
        }
      },
    );
  });
}

interface Running {
  events: Emitter<RuntimeEvent>;
  backlog: RuntimeEvent[];
  pid: number | null;
  cancelled: boolean;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value
          .map((part) => (isObject(part) && typeof part.text === 'string' ? part.text : ''))
          .join('\n')
      : '';

export class ClaudeCodeRuntime implements AgentRuntime {
  readonly id = 'claude-code';
  private readonly sessions = new Map<string, Running>();

  constructor(private readonly options: ClaudeCodeOptions) {}

  async start(input: AgentTaskInput): Promise<AgentSession> {
    const running: Running = {
      events: new Emitter<RuntimeEvent>(),
      backlog: [],
      pid: null,
      cancelled: false,
    };
    this.sessions.set(input.sessionId, running);
    const emit = (event: RuntimeEvent) => {
      const bounded = { ...event, message: clipText(event.message, 4_000) };
      running.backlog.push(bounded);
      if (running.backlog.length > 500) running.backlog.shift();
      running.events.emit(bounded);
    };
    const done = this.run(input, running, emit).finally(() =>
      this.sessions.delete(input.sessionId),
    );
    return { id: input.sessionId, done };
  }

  async cancel(sessionId: string): Promise<void> {
    const running = this.sessions.get(sessionId);
    if (!running) return;
    running.cancelled = true;
    if (running.pid) killTree(running.pid);
  }

  subscribe(sessionId: string, onEvent: (event: RuntimeEvent) => void): () => void {
    const running = this.sessions.get(sessionId);
    if (!running) return () => undefined;
    for (const event of running.backlog) onEvent(event);
    return running.events.on(onEvent);
  }

  /** The prompt: the agent's role and Hive's rules first, then the task as Hive writes it. */
  private prompt(input: AgentTaskInput): string {
    const role = input.worker.systemPrompt.trim();
    // 'project': the user's own folder, with the user following along (Direct Agent Chat).
    const rules = input.readOnly
      ? `You are ${input.worker.name}, working for Hive, a team of coding agents, talking with the user. The current directory is the user's project. Only read it: do not edit files or run commands. Answer in the user's language.`
      : input.place === 'project'
        ? `You are ${input.worker.name}, working for Hive, a team of coding agents, talking with the user. The current directory is the user's project folder: edits apply at once. Work only inside it. No git commit, push, merge, rebase or reset unless asked. End with a short summary of what you changed and how you verified it, in the user's language.`
        : `You are ${input.worker.name}, working for Hive, a team of coding agents. Work only inside the current directory, which is an isolated copy of the project. Do not commit; Hive snapshots your changes when you finish. End with a short summary of what you changed and how you verified it.`;
    return [rules, role ? `## Your role\n${role}` : '', buildTaskPrompt(input)]
      .filter(Boolean)
      .join('\n\n');
  }

  private args(input: AgentTaskInput, claudeSession: string, mcpConfig: string | null): string[] {
    const args = [
      ...(this.options.argsPrefix ?? []),
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--session-id',
      claudeSession,
      '--permission-mode',
      'acceptEdits',
      '--max-turns',
      String(Math.max(1, input.limits.maxSteps)),
    ];
    if (input.model && input.model !== 'default') args.push('--model', input.model);
    // Read-only (a Direct Agent Chat conversation): editing and shell tools are refused outright,
    // before any permission prompt.
    const readOnly = input.readOnly ? [...FILE_TOOLS, ...COMMAND_TOOLS] : [];
    if (mcpConfig)
      // Only Hive's server: the user's own MCP servers are not part of a Hive task.
      args.push(
        '--mcp-config',
        mcpConfig,
        '--strict-mcp-config',
        '--permission-prompt-tool',
        PERMISSION_TOOL,
      );
    else {
      // Nothing waits for an answer nobody can give: what would prompt is refused.
      args.push('--permission-prompts', 'none');
      if (this.options.allowCommands?.() && !input.readOnly)
        args.push('--allowedTools', 'Bash', 'PowerShell');
      else readOnly.push(...COMMAND_TOOLS);
    }
    const refused = [...new Set(readOnly)];
    if (refused.length) args.push('--disallowedTools', ...refused);
    // In read-only mode Claude Code must not auto-accept edits either.
    if (input.readOnly) args[args.indexOf('acceptEdits')] = 'default';
    return args;
  }

  /** Each permission prompt becomes a Hive approval; a command is shown as the command. */
  private approver(input: AgentTaskInput, emit: (event: RuntimeEvent) => void): PermissionHandler {
    return async (tool, toolInput) => {
      const command =
        COMMAND_TOOLS.has(tool) && typeof toolInput.command === 'string'
          ? toolInput.command
          : `${tool}: ${clipText(JSON.stringify(toolInput), 300)}`;
      const allowed = await input.requestApproval({ command });
      emit({
        type: 'info',
        level: allowed ? 'info' : 'warn',
        message: `Claude Code pediu permissão (${tool}): ${allowed ? 'liberada' : 'negada'}.`,
        data: { tool, allowed },
      });
      return allowed
        ? { behavior: 'allow', updatedInput: toolInput }
        : { behavior: 'deny', message: 'O usuário do Hive não liberou esta ação.' };
    };
  }

  private async run(
    input: AgentTaskInput,
    running: Running,
    emit: (event: RuntimeEvent) => void,
  ): Promise<AgentOutcome> {
    const usage = { promptTokens: 0, completionTokens: 0 };
    const commands: CommandEvidence[] = [];
    let steps = 0;
    const fail = (error: string, status: AgentOutcome['status'] = 'failed'): AgentOutcome => {
      emit({
        type: status === 'cancelled' ? 'info' : 'error',
        level: status === 'cancelled' ? 'warn' : 'error',
        message: error,
      });
      return { status, summary: '', error: clipText(error), steps, usage, commands };
    };

    if (!this.options.allowApiBilling) {
      let auth: ClaudeCodeAuth;
      try {
        auth = await claudeCodeAuth(this.options);
      } catch (error) {
        return fail(errorMessage(error));
      }
      if (!auth.loggedIn)
        return fail(
          'O Claude Code não está conectado. Rode "claude" uma vez no terminal e entre com a sua conta claude.ai.',
        );
      if (auth.authMethod !== 'claude.ai')
        return fail(
          `Trava de custo: o Claude Code está conectado por "${auth.authMethod ?? 'desconhecido'}", que cobra por uso. Entre com a conta claude.ai ("claude auth login") para usar a cota do seu plano.`,
        );
    }
    if (running.cancelled) return fail('Cancelada antes de começar.', 'cancelled');

    const claudeSession = randomUUID();
    let permission: { config: string; release: () => void } | null;
    try {
      permission = (await this.options.permissions?.register(this.approver(input, emit))) ?? null;
    } catch (error) {
      return fail(`Não foi possível preparar as aprovações do Hive: ${errorMessage(error)}`);
    }
    const env = cleanEnv();
    // A prompt waits for the user like Hive's own approvals do, not for the MCP default.
    if (permission) env.MCP_TOOL_TIMEOUT = String(24 * 60 * 60 * 1000);
    const child = spawn(
      this.options.executable,
      this.args(input, claudeSession, permission?.config ?? null),
      {
        cwd: input.worktreePath,
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    running.pid = child.pid ?? null;
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 32_000) stderr += chunk.toString('utf8');
    });
    const exited = new Promise<{ code: number | null; error: Error | null }>((resolve) => {
      child.on('error', (error) => resolve({ code: null, error }));
      child.on('close', (code) => resolve({ code, error: null }));
    });
    child.stdin.on('error', () => undefined); // a process that died early closes its stdin
    child.stdin.end(this.prompt(input));

    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        if (running.pid) killTree(running.pid);
      },
      Math.max(1_000, input.limits.taskTimeoutMin * 60_000),
    );

    const tools = new Map<string, { name: string; command: string | null; started: number }>();
    let result: Json | null = null;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let message: Json;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isObject(parsed)) throw new Error('not an object');
        message = parsed;
      } catch {
        emit({
          type: 'info',
          level: 'debug',
          message: `Claude Code: linha fora do formato JSON: ${line}`,
        });
        continue;
      }
      if (message.type === 'system' && message.subtype === 'init') {
        emit({
          type: 'session.started',
          level: 'info',
          message: `${input.worker.name} começou no Claude Code (${typeof message.model === 'string' ? message.model : 'modelo padrão'}).`,
          data: {
            engine: 'claude-code',
            claudeSessionId: claudeSession,
            model: message.model ?? null,
          },
        });
      } else if (message.type === 'assistant' && isObject(message.message)) {
        steps++;
        const content = Array.isArray(message.message.content) ? message.message.content : [];
        for (const block of content.filter(isObject)) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim())
            emit({ type: 'model.response', level: 'info', message: block.text });
          if (block.type !== 'tool_use' || typeof block.name !== 'string') continue;
          const toolInput = isObject(block.input) ? block.input : {};
          const command =
            COMMAND_TOOLS.has(block.name) && typeof toolInput.command === 'string'
              ? toolInput.command
              : null;
          if (typeof block.id === 'string')
            tools.set(block.id, { name: block.name, command, started: Date.now() });
          emit({
            type: 'tool.call',
            level: 'debug',
            message: `${block.name}: ${clipText(JSON.stringify(toolInput), 400)}`,
            data: { tool: block.name },
          });
          if (command)
            emit({ type: 'command.started', level: 'info', message: command, data: { command } });
          if (FILE_TOOLS.has(block.name) && typeof toolInput.file_path === 'string')
            emit({
              type: 'file.changed',
              level: 'info',
              message: `Editou ${path.relative(input.worktreePath, toolInput.file_path) || toolInput.file_path}`,
              data: {
                path: path.relative(input.worktreePath, toolInput.file_path),
                action: block.name,
              },
            });
        }
      } else if (message.type === 'user' && isObject(message.message)) {
        const content = Array.isArray(message.message.content) ? message.message.content : [];
        for (const block of content.filter(isObject)) {
          if (block.type !== 'tool_result') continue;
          const tool =
            typeof block.tool_use_id === 'string' ? tools.get(block.tool_use_id) : undefined;
          const output = text(block.content);
          const failed = block.is_error === true;
          emit({
            type: 'tool.result',
            level: failed ? 'warn' : 'debug',
            message: `${tool?.name ?? 'ferramenta'}: ${clipText(output, 600)}`,
          });
          if (tool?.command) {
            const durationMs = Date.now() - tool.started;
            // Claude Code reports a failed command, not its exit code: the code stays unknown.
            commands.push({
              command: tool.command,
              exitCode: null,
              durationMs,
              timedOut: false,
              outputTail: output.slice(-2_000),
            });
            emit({
              type: 'command.finished',
              level: failed ? 'warn' : 'info',
              message: `${tool.command} → ${failed ? 'falhou' : 'terminou'}`,
              data: { command: tool.command, exitCode: null, failed },
            });
          }
        }
      } else if (message.type === 'result') {
        result = message;
      }
    }
    const { code, error } = await exited;
    clearTimeout(timer);
    permission?.release();

    if (isObject(result?.usage)) {
      const u = result.usage;
      const n = (key: string) => (typeof u[key] === 'number' ? (u[key] as number) : 0);
      usage.promptTokens =
        n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens');
      usage.completionTokens = n('output_tokens');
    }
    if (result)
      emit({
        type: 'session.finished',
        level: 'info',
        message: `Claude Code terminou: ${String(result.subtype)} em ${typeof result.num_turns === 'number' ? result.num_turns : steps} turno(s).`,
        data: {
          engine: 'claude-code',
          claudeSessionId: claudeSession,
          numTurns: result.num_turns ?? null,
          durationMs: result.duration_ms ?? null,
          // What the same work would cost on the API; on a claude.ai plan it uses the quota.
          costUsd: result.total_cost_usd ?? null,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
        },
      });

    if (running.cancelled) return fail('Cancelada pelo usuário.', 'cancelled');
    if (timedOut)
      return fail(
        `Tempo limite de ${input.limits.taskTimeoutMin} min esgotado; o Claude Code foi encerrado.`,
      );
    if (error)
      return fail(
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'O Claude Code não foi encontrado. Instale com "npm install -g @anthropic-ai/claude-code".'
          : `Não foi possível iniciar o Claude Code: ${errorMessage(error)}`,
      );
    if (!result)
      return fail(
        `O Claude Code saiu (código ${code}) sem resultado. ${clipText(stderr.trim(), 2_000)}`,
      );
    const summary = typeof result.result === 'string' ? result.result : '';
    if (result.subtype !== 'success' || result.is_error === true) {
      const errors = Array.isArray(result.errors) ? result.errors.map(String).join('; ') : '';
      return fail(
        `Claude Code: ${String(result.subtype)}${summary || errors ? ` — ${summary || errors}` : ''}`,
      );
    }
    return { status: 'completed', summary: clipText(summary), error: null, steps, usage, commands };
  }
}
