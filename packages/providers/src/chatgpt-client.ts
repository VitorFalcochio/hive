import { HiveError, errorMessage, secretRedactor } from '@hive/shared';
import type { ModelInfo } from '@hive/core';
import { CHATGPT_RESOURCE, CHATGPT_USAGE_URL } from './chatgpt-auth';
import { modelFamily } from './models';
import { ProviderError, parseRetryAfter } from './retry';
import type { ChatMessage, ChatRequest, ChatResponse, ToolCall, ToolDefinition } from './types';

type FetchLike = typeof fetch;
const CHAT_TIMEOUT_MS = 300_000;
/** Plan requests require function tools grouped in a namespace. */
const NAMESPACE = 'hive';

/** Where the client gets its bearer token; `force` after a 401 asks for a refreshed one. */
export interface AccessTokenSource {
  accessToken(force?: boolean): Promise<string>;
}

/** Responses API input items, only the shapes Hive sends. */
type InputItem = Record<string, unknown>;

/**
 * Turns Hive's Chat Completions history into Responses `instructions` + `input`. Plan requests
 * are stateless (`store: false`), so the whole history goes every time.
 */
export function toResponsesInput(messages: ChatMessage[]): {
  instructions: string | undefined;
  input: InputItem[];
} {
  const system: string[] = [];
  const input: InputItem[] = [];
  let seenOther = false;
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        // System items are refused on this route: leading ones become `instructions`, later
        // ones developer messages.
        if (!seenOther) system.push(message.content);
        else input.push({ role: 'developer', content: message.content });
        break;
      case 'user':
        seenOther = true;
        input.push({
          role: 'user',
          content:
            typeof message.content === 'string'
              ? message.content
              : message.content.map((part) =>
                  part.type === 'text'
                    ? { type: 'input_text', text: part.text }
                    : { type: 'input_image', image_url: part.image_url.url },
                ),
        });
        break;
      case 'assistant':
        seenOther = true;
        if (message.content) input.push({ role: 'assistant', content: message.content });
        for (const call of message.tool_calls ?? [])
          input.push({
            type: 'function_call',
            call_id: call.id,
            name: call.function.name,
            namespace: NAMESPACE,
            arguments: call.function.arguments,
          });
        break;
      case 'tool':
        seenOther = true;
        input.push({
          type: 'function_call_output',
          call_id: message.tool_call_id,
          output: message.content,
        });
        break;
    }
  }
  return { instructions: system.length ? system.join('\n\n') : undefined, input };
}

export function toResponsesTools(tools: ToolDefinition[]): InputItem[] {
  return [
    {
      type: 'namespace',
      name: NAMESPACE,
      description: 'Tools of the Hive agent: files, search, commands and skills.',
      tools: tools.map((tool) => ({
        type: 'function',
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      })),
    },
  ];
}

interface OutputItem {
  type?: string;
  call_id?: string;
  id?: string;
  name?: string;
  namespace?: string;
  arguments?: string;
  /** Custom (free-form) tool calls carry `input` instead of `arguments`. */
  input?: string;
  content?: { type?: string; text?: string }[];
  summary?: { text?: string }[];
}

interface ResponseBody {
  status?: string;
  output?: OutputItem[];
  usage?: { input_tokens?: number; output_tokens?: number };
  incomplete_details?: { reason?: string } | null;
  error?: { code?: string; message?: string } | null;
  /** Event types seen in the stream, for diagnosing a response Hive could not read. */
  events?: string[];
  /** Text streamed as deltas, when no output item carried it. */
  streamedText?: string;
}

/** Reads the final response out of the event stream, or the error that ended it. */
export async function readResponseStream(body: ReadableStream<Uint8Array>): Promise<ResponseBody> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  // Without storage the final event may list no output: items also arrive one by one.
  const items: OutputItem[] = [];
  const events = new Set<string>();
  let streamedText = '';
  const finish = (response: ResponseBody | undefined): ResponseBody => ({
    ...response,
    output: response?.output?.length ? response.output : items,
    events: [...events],
    streamedText,
  });
  const handle = (block: string): ResponseBody | null => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return null;
    let event: {
      type?: string;
      response?: ResponseBody;
      error?: ResponseBody['error'];
      item?: OutputItem;
      delta?: string;
    };
    try {
      event = JSON.parse(data) as typeof event;
    } catch {
      return null;
    }
    if (event.type) events.add(event.type);
    if (event.type === 'response.output_item.done' && event.item) items.push(event.item);
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string')
      streamedText += event.delta;
    if (event.type === 'response.completed' || event.type === 'response.incomplete')
      return finish(event.response);
    if (event.type === 'response.failed') throw planError(null, event.response?.error ?? null);
    if (event.type === 'error')
      throw planError(null, event.error ?? (event as { code?: string; message?: string }));
    return null;
  };
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const final = handle(block);
      if (final) {
        void reader.cancel().catch(() => undefined);
        return final;
      }
    }
    if (done) {
      const final = handle(buffer);
      if (final) return final;
      throw new ProviderError('A resposta do ChatGPT foi interrompida antes de terminar.', null);
    }
  }
}

/** Plan-specific error codes to Hive errors that retry and failover understand. */
export function planError(
  status: number | null,
  error: { code?: string; message?: string; param?: string } | null,
  retryAfterMs: number | null = null,
): HiveError {
  const code = error?.code ?? '';
  const detail = secretRedactor.redact(error?.message ?? '').slice(0, 300);
  switch (code) {
    case 'subscription_sharing_usage_limit_exceeded':
      // Not a passing rate limit: waiting minutes will not help. 402 makes failover rest the
      // route for a long while instead of retrying it.
      return new ProviderError(
        `Limite de uso do plano ChatGPT atingido para o Hive. Veja ou ajuste em ${CHATGPT_USAGE_URL}`,
        402,
      );
    case 'subscription_sharing_user_not_eligible':
      return new HiveError(
        'PROVIDER_AUTH',
        'Sua conta do ChatGPT não pode usar o plano em outros aplicativos (o plano precisa ser Go, Plus ou Pro).',
      );
    case 'subscription_sharing_usage_unavailable':
    case 'subscription_sharing_user_unavailable':
      return new ProviderError(
        'O uso do plano ChatGPT está indisponível agora. Tentando de novo.',
        503,
        retryAfterMs,
      );
    case 'subscription_sharing_invalid_user':
      return new HiveError(
        'PROVIDER_AUTH',
        'O ChatGPT não reconheceu a sessão. Entre de novo em Provedores.',
      );
    case 'subscription_sharing_unsupported_capability':
      return new ProviderError(
        `O plano ChatGPT não aceita parte deste pedido${error?.param ? ` (${error.param})` : ''}. ${detail}`.trim(),
        400,
      );
  }
  if (status === 401 || status === 403)
    return new HiveError(
      'PROVIDER_AUTH',
      `O ChatGPT recusou o acesso (${status}). ${detail}`.trim(),
    );
  if (status === 404)
    return new ProviderError(
      `Modelo não disponível no seu plano ChatGPT (404). ${detail}`.trim(),
      404,
    );
  if (status === null)
    // Failed mid-stream: a server-side problem unless it said otherwise.
    return new ProviderError(
      `O ChatGPT falhou ao responder${code ? ` (${code})` : ''}. ${detail}`.trim(),
      500,
    );
  return new ProviderError(
    `Erro do ChatGPT ${status}${code ? ` (${code})` : ''}. ${detail}`.trim(),
    status,
    retryAfterMs,
  );
}

/**
 * Client for "Sign in with ChatGPT" plan usage: the public Responses API with the user's OAuth
 * token. It offers the same calls as `OpenAICompatibleClient`, so the rest of Hive does not care
 * which one it holds.
 */
export class ChatGPTPlanClient {
  constructor(
    private readonly providerId: string,
    private readonly tokens: AccessTokenSource,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = CHATGPT_RESOURCE,
  ) {}

  private async send(
    pathname: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    for (let attempt = 0; ; attempt++) {
      const token = await this.tokens.accessToken(attempt > 0);
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}${pathname}`, {
          ...init,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: init.method === 'POST' ? 'text/event-stream' : 'application/json',
          },
          signal: combined,
        });
      } catch (error) {
        if (signal?.aborted) throw new HiveError('CANCELLED', 'Request cancelled.');
        if (timeout.aborted)
          throw new HiveError(
            'TIMEOUT',
            `O ChatGPT não respondeu em ${Math.round(timeoutMs / 1000)}s.`,
          );
        throw new ProviderError(
          `Não foi possível falar com a OpenAI: ${secretRedactor.redact(errorMessage(error))}`,
          null,
        );
      }
      // An access token can be revoked before it expires: refresh once and try again.
      if (response.status === 401 && attempt === 0) continue;
      if (!response.ok) throw await this.httpError(response);
      return response;
    }
  }

  private async httpError(response: Response): Promise<HiveError> {
    let error: { code?: string; message?: string; param?: string } | null = null;
    try {
      const body = (await response.json()) as {
        error?: { code?: string; message?: string; param?: string };
        detail?: string;
      };
      error = body.error ?? (body.detail ? { message: body.detail } : null);
    } catch {
      // no body
    }
    return planError(response.status, error, parseRetryAfter(response.headers.get('retry-after')));
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const response = await this.send('/models', { method: 'GET' }, signal, 30_000);
    const body = (await response.json()) as {
      models?: {
        slug?: string;
        display_name?: string;
        visibility?: string;
        context_window?: number;
      }[];
      data?: { id?: string }[];
    };
    const rows =
      body.models?.filter((model) => model.visibility === 'list' && model.slug) ??
      body.data?.map((model) => ({
        slug: model.id,
        display_name: model.id,
        context_window: undefined,
      })) ??
      [];
    return rows
      .map((model): ModelInfo => ({
        id: model.slug!,
        providerId: this.providerId,
        displayName: model.display_name || model.slug!,
        family: modelFamily(model.slug!),
        contextWindow:
          typeof model.context_window === 'number' && model.context_window > 0
            ? model.context_window
            : null,
        // Every model the plan lists is a GPT model with function calling, reasoning and vision.
        capabilities: {
          tools: 'yes',
          structuredOutput: 'yes',
          reasoning: 'yes',
          vision: 'unknown',
        },
        capabilitySource: 'provider-metadata',
        pricing: { inputPerMTok: 0, outputPerMTok: 0 },
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async testConnection(signal?: AbortSignal): Promise<{ latencyMs: number; modelCount: number }> {
    const started = Date.now();
    const models = await this.listModels(signal);
    return { latencyMs: Date.now() - started, modelCount: models.length };
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const { instructions, input } = toResponsesInput(request.messages);
    // temperature and max_output_tokens are refused on this route.
    const payload: Record<string, unknown> = {
      model: request.model,
      input,
      store: false,
      stream: true,
    };
    if (instructions) payload.instructions = instructions;
    if (request.tools?.length) payload.tools = toResponsesTools(request.tools);
    if (request.jsonMode) payload.text = { format: { type: 'json_object' } };

    const started = Date.now();
    const response = await this.send(
      '/responses',
      { method: 'POST', body: JSON.stringify(payload) },
      signal,
      CHAT_TIMEOUT_MS,
    );
    if (!response.body) throw new HiveError('PROVIDER', 'O ChatGPT respondeu sem conteúdo.');
    const body = await readResponseStream(response.body);

    const text: string[] = [];
    const reasoning: string[] = [];
    const toolCalls: ToolCall[] = [];
    const output = body.output ?? [];
    for (const item of output) {
      if (item.type === 'message')
        for (const part of item.content ?? [])
          if (part.type === 'output_text' && part.text) text.push(part.text);
      if (item.type === 'reasoning')
        for (const part of item.summary ?? []) if (part.text) reasoning.push(part.text);
      // `function_call`, or a namespaced/custom variant: anything naming one of our tools.
      if (
        item.name &&
        /(^|_)call$/.test(item.type ?? '') &&
        !/^(web_search|image_generation)/.test(item.type ?? '')
      )
        toolCalls.push({
          id: item.call_id || item.id || `call_${toolCalls.length}`,
          type: 'function',
          // Some routes prefix the namespace; Hive's tools are plain names.
          function: {
            name: item.name.replace(/^hive(\.|__)/, ''),
            arguments: item.arguments || item.input || '{}',
          },
        });
    }
    if (!text.length && body.streamedText) text.push(body.streamedText);
    // A reply that spent tokens yet holds nothing Hive can read must not pass for a final answer.
    if (!text.length && !toolCalls.length && (body.usage?.output_tokens ?? 0) > 0)
      throw new ProviderError(
        `O ChatGPT respondeu num formato que o Hive não reconheceu (itens: ${
          output.map((item) => item.type ?? '?').join(', ') || 'nenhum'
        }; eventos: ${(body.events ?? []).join(', ')}).`,
        422,
      );
    const incomplete = body.status === 'incomplete';
    return {
      message: {
        role: 'assistant',
        content: text.length ? text.join('') : null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      reasoning: reasoning.length ? reasoning.join('\n') : null,
      finishReason: toolCalls.length ? 'tool_calls' : incomplete ? 'length' : 'stop',
      usage: body.usage
        ? {
            promptTokens: body.usage.input_tokens ?? 0,
            completionTokens: body.usage.output_tokens ?? 0,
          }
        : null,
      latencyMs: Date.now() - started,
    };
  }

  async embed(): Promise<number[][]> {
    throw new HiveError(
      'PROVIDER',
      'O plano ChatGPT não oferece embeddings. Use outro provedor para a memória (Nectar).',
    );
  }

  async testModel(modelId: string, signal?: AbortSignal): Promise<{ latencyMs: number }> {
    const timeout = AbortSignal.timeout(60_000);
    const response = await this.chat(
      { model: modelId, messages: [{ role: 'user', content: 'Reply with: ok' }] },
      signal ? AbortSignal.any([signal, timeout]) : timeout,
    );
    return { latencyMs: response.latencyMs };
  }

  async probeTools(
    modelId: string,
    signal?: AbortSignal,
  ): Promise<{ tools: 'yes' | 'no' | 'unknown'; message: string }> {
    const response = await this.chat(
      {
        model: modelId,
        messages: [
          {
            role: 'user',
            content: 'Call the `ping` tool with {"value": "hive"}. Do not reply with text.',
          },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'ping',
              description: 'Connectivity check.',
              parameters: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
              },
            },
          },
        ],
      },
      signal,
    );
    return response.message.tool_calls?.some((call) => call.function.name === 'ping')
      ? { tools: 'yes', message: 'Model returned a well-formed tool call.' }
      : {
          tools: 'unknown',
          message: 'Model replied without calling the tool; support is unconfirmed.',
        };
  }
}
