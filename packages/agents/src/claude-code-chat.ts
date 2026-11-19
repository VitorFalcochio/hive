import { spawn } from 'node:child_process';
import type { ModelInfo } from '@hive/core';
import {
  ProviderError,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
} from '@hive/providers';
import { HiveError, clipText, errorMessage } from '@hive/shared';
import { claudeCodeAuth, cleanEnv, type ClaudeCodeAuth } from './claude-code';
import { killTree } from './process';

/**
 * Claude Code as a provider in Providers, like ChatGPT: no API key, the user's own sign-in and
 * plan quota. Text requests (the Queen's plans, chats, summaries) run through the official
 * `claude -p --output-format json` with every tool turned off, so it only answers. Agent tasks
 * with this provider run on ClaudeCodeRuntime instead, with Claude Code's own tools and Hive's
 * approvals; a request that carries Hive's tools is refused here with that explanation.
 *
 * Cost lock: every call checks that Claude Code is signed in with claude.ai (plan quota);
 * an API-key sign-in, which bills per use, is refused.
 */
export interface ClaudeCodeChatOptions {
  providerId: string;
  executable: string;
  argsPrefix?: string[];
  /** Longest a single answer may take. */
  timeoutMs?: number;
}

/** Aliases Claude Code accepts for `--model`; `default` keeps the model set in Claude Code. */
export const CLAUDE_CODE_MODELS: { id: string; name: string }[] = [
  { id: 'default', name: 'Modelo padrão do seu Claude Code' },
  { id: 'sonnet', name: 'Claude Sonnet (mais recente)' },
  { id: 'opus', name: 'Claude Opus (mais recente)' },
  { id: 'haiku', name: 'Claude Haiku (mais recente)' },
];
const AUTH_TTL_MS = 2 * 60_000;

function textOf(content: ChatMessage['content']): string {
  if (content === null) return '';
  if (typeof content === 'string') return content;
  return content
    .map((part) =>
      part.type === 'text' ? part.text : '[imagem omitida: o Claude Code recebe só texto aqui]',
    )
    .join('\n');
}

/** The conversation as one prompt: Claude Code -p takes a single message on stdin. */
export function conversationPrompt(request: ChatRequest): string {
  const parts: string[] = [];
  const system = request.messages.filter((message) => message.role === 'system');
  if (system.length)
    parts.push(
      `<instructions>\n${system.map((message) => textOf(message.content)).join('\n\n')}\n</instructions>`,
    );
  const turns = request.messages.filter((message) => message.role !== 'system');
  if (turns.length > 1 || turns[0]?.role !== 'user') {
    parts.push(
      `<conversation>\n${turns
        .map((message) => `[${message.role}]\n${textOf(message.content)}`)
        .join('\n\n')}\n</conversation>`,
      'Reply to the last user message of the conversation above, as the assistant.',
    );
  } else parts.push(textOf(turns[0].content));
  if (request.jsonMode) parts.push('Reply with only one JSON object, with no text around it.');
  return parts.join('\n\n');
}

export class ClaudeCodePlanClient {
  private auth: { value: ClaudeCodeAuth; at: number } | null = null;

  constructor(private readonly options: ClaudeCodeChatOptions) {}

  /** The sign-in, read again every few minutes; only claude.ai passes the cost lock. */
  async account(force = false): Promise<ClaudeCodeAuth> {
    if (!force && this.auth && Date.now() - this.auth.at < AUTH_TTL_MS) return this.auth.value;
    const value = await claudeCodeAuth({
      executable: this.options.executable,
      argsPrefix: this.options.argsPrefix,
    });
    this.auth = { value, at: Date.now() };
    return value;
  }

  private async requireAccount(): Promise<ClaudeCodeAuth> {
    const auth = await this.account();
    if (!auth.loggedIn)
      throw new ProviderError(
        'O Claude Code não está conectado. Rode "claude" no terminal uma vez e entre com a sua conta claude.ai.',
        401,
      );
    if (auth.authMethod !== 'claude.ai')
      throw new ProviderError(
        `Trava de custo: o Claude Code está conectado por "${auth.authMethod ?? 'desconhecido'}", que cobra por uso. Entre com a conta claude.ai ("claude auth login") para usar a cota do seu plano.`,
        401,
      );
    return auth;
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    if (request.tools?.length)
      throw new HiveError(
        'PROVIDER',
        'O Claude Code não executa as ferramentas do Hive por aqui. Tarefas de agentes com este provedor rodam no motor Claude Code, com as ferramentas dele.',
      );
    await this.requireAccount();
    const started = Date.now();
    const args = [
      ...(this.options.argsPrefix ?? []),
      '-p',
      '--output-format',
      'json',
      // Only answers: no tools, no MCP servers, no slash commands, nothing kept on disk.
      '--tools',
      '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--max-turns',
      '1',
    ];
    if (request.model && request.model !== 'default') args.push('--model', request.model);
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(this.options.executable, args, {
        env: cleanEnv(),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let done = false;
      const stop = (error: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (child.pid) killTree(child.pid);
        reject(error);
      };
      const timer = setTimeout(
        () => stop(new ProviderError('O Claude Code passou do tempo limite para responder.', 504)),
        this.options.timeoutMs ?? 10 * 60_000,
      );
      const onAbort = () => stop(new HiveError('CANCELLED', 'Pedido ao Claude Code cancelado.'));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 16_000) stderr += chunk.toString('utf8');
      });
      child.on('error', (error) =>
        stop(
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? new ProviderError(
                'O Claude Code não foi encontrado. Instale com "npm install -g @anthropic-ai/claude-code".',
                null,
              )
            : new ProviderError(
                `Não foi possível iniciar o Claude Code: ${errorMessage(error)}`,
                null,
              ),
        ),
      );
      child.on('close', (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (!stdout.trim())
          reject(
            new ProviderError(
              `O Claude Code saiu (código ${code}) sem resposta. ${clipText(stderr.trim(), 2_000)}`,
              502,
            ),
          );
        else resolve(stdout);
      });
      child.stdin.on('error', () => undefined); // a process that died early; its exit says why
      child.stdin.end(conversationPrompt(request));
    });

    let result: Record<string, unknown>;
    try {
      result = JSON.parse(output.trim().split('\n').at(-1) ?? '') as Record<string, unknown>;
    } catch {
      throw new ProviderError(
        `Resposta do Claude Code fora do formato JSON: ${clipText(output, 1_000)}`,
        502,
      );
    }
    const text = typeof result.result === 'string' ? result.result : '';
    if (result.is_error === true || result.subtype !== 'success') {
      // A plan limit is a rate limit to the rest of Hive: waited out or routed elsewhere.
      const limited = /limit|rate|quota|overloaded/i.test(text);
      throw new ProviderError(
        `Claude Code: ${clipText(text || String(result.subtype), 2_000)}`,
        limited ? 429 : 502,
      );
    }
    const usage = (result.usage ?? {}) as Record<string, unknown>;
    const n = (key: string) => (typeof usage[key] === 'number' ? (usage[key] as number) : 0);
    return {
      message: { role: 'assistant', content: text },
      reasoning: null,
      finishReason: 'stop',
      usage: {
        promptTokens:
          n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens'),
        completionTokens: n('output_tokens'),
        cachedTokens: n('cache_read_input_tokens'),
      },
      latencyMs: Date.now() - started,
    };
  }

  /** The aliases Claude Code takes; nothing to download, and no quota spent. */
  async listModels(): Promise<ModelInfo[]> {
    await this.requireAccount();
    return CLAUDE_CODE_MODELS.map((model) => ({
      id: model.id,
      providerId: this.options.providerId,
      displayName: model.name,
      family: 'claude',
      contextWindow: null,
      // Agents with this provider run on Claude Code, which has its own tools.
      capabilities: { tools: 'yes', structuredOutput: 'unknown', reasoning: 'yes', vision: 'no' },
      capabilitySource: 'provider-metadata',
      // Plan quota, never billed per token.
      pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    }));
  }

  /** Reads the sign-in only: testing the connection spends none of the plan. */
  async testConnection(): Promise<{ latencyMs: number; modelCount: number }> {
    const started = Date.now();
    this.auth = null;
    const models = await this.listModels();
    return { latencyMs: Date.now() - started, modelCount: models.length };
  }

  async testModel(modelId: string, signal?: AbortSignal): Promise<{ latencyMs: number }> {
    const response = await this.chat(
      { model: modelId, messages: [{ role: 'user', content: 'Reply with: ok' }] },
      signal,
    );
    return { latencyMs: response.latencyMs };
  }

  async embed(): Promise<number[][]> {
    throw new HiveError(
      'PROVIDER',
      'O Claude Code não oferece embeddings. Use outro provedor para a memória (Nectar).',
    );
  }
}
