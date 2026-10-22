import { HiveError, errorMessage, secretRedactor } from '@hive/shared';
import type { ModelInfo } from '@hive/core';
import { normalizeModels } from './models';
import { ProviderError, parseRetryAfter } from './retry';
import type { ChatClient, ChatRequest, ChatResponse, ProviderEndpoint, ToolCall } from './types';

const DEFAULT_TIMEOUT_MS = 120_000;
type FetchLike = typeof fetch;

/**
 * Client for OpenAI-compatible Chat Completions APIs (OpenAI, Groq, NVIDIA, DeepSeek,
 * OpenRouter and local servers). Error messages are redacted before they leave this class.
 */
export class OpenAICompatibleClient implements ChatClient {
  constructor(
    private readonly endpoint: ProviderEndpoint,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    if (endpoint.apiKey) secretRedactor.register(endpoint.apiKey);
  }

  private url(pathname: string): string {
    return `${this.endpoint.baseUrl.replace(/\/+$/, '')}${pathname}`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (this.endpoint.apiKey) headers.authorization = `Bearer ${this.endpoint.apiKey}`;
    if (this.endpoint.kind === 'openrouter') headers['x-title'] = 'Hive';
    return headers;
  }

  private async request(
    pathname: string,
    init: RequestInit,
    signal?: AbortSignal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(pathname), {
        ...init,
        headers: this.headers(),
        signal: combined,
      });
    } catch (error) {
      if (signal?.aborted) throw new HiveError('CANCELLED', 'Request cancelled.');
      if (timeout.aborted)
        throw new HiveError(
          'TIMEOUT',
          `Provider did not respond within ${Math.round(timeoutMs / 1000)}s.`,
        );
      throw new ProviderError(
        `Could not reach ${this.endpoint.baseUrl}: ${secretRedactor.redact(errorMessage(error))}`,
        null,
      );
    }
    if (!response.ok) throw await this.httpError(response);
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new HiveError('PROVIDER', 'Provider returned a response that is not valid JSON.');
    }
  }

  private async httpError(response: Response): Promise<HiveError> {
    let detail = '';
    try {
      const text = await response.text();
      try {
        const body = JSON.parse(text) as {
          error?: { message?: string } | string;
          message?: string;
          detail?: string;
        };
        detail =
          (typeof body.error === 'string' ? body.error : body.error?.message) ??
          body.message ??
          body.detail ??
          text;
      } catch {
        detail = text;
      }
    } catch {
      // body unavailable
    }
    detail = secretRedactor.redact(detail).slice(0, 500);
    const status = response.status;
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
    if (status === 401 || status === 403) {
      return new HiveError(
        'PROVIDER_AUTH',
        `Authentication failed (${status}). Check the API key. ${detail}`.trim(),
      );
    }
    if (status === 429)
      return new ProviderError(
        `Rate limited or out of quota (429). ${detail}`.trim(),
        status,
        retryAfter,
      );
    if (status === 404)
      return new ProviderError(
        `Not found (404) — check the endpoint and model id. ${detail}`.trim(),
        status,
      );
    return new ProviderError(`Provider error ${status}. ${detail}`.trim(), status, retryAfter);
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const body = await this.request('/models', { method: 'GET' }, signal, 30_000);
    return normalizeModels(this.endpoint, body);
  }

  /** Cheapest authenticated call available on every provider: listing models. */
  async testConnection(signal?: AbortSignal): Promise<{ latencyMs: number; modelCount: number }> {
    const started = Date.now();
    const models = await this.listModels(signal);
    return { latencyMs: Date.now() - started, modelCount: models.length };
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const payload: Record<string, unknown> = { model: request.model, messages: request.messages };
    if (request.tools?.length) payload.tools = request.tools;
    if (request.temperature !== null && request.temperature !== undefined)
      payload.temperature = request.temperature;
    if (request.maxTokens) payload.max_tokens = request.maxTokens;
    if (request.jsonMode) payload.response_format = { type: 'json_object' };
    if (this.endpoint.kind === 'openrouter') payload.usage = { include: true };

    const started = Date.now();
    const body = (await this.request(
      '/chat/completions',
      { method: 'POST', body: JSON.stringify(payload) },
      signal,
    )) as {
      choices?: {
        message?: {
          content?: string | null;
          tool_calls?: ToolCall[];
          reasoning_content?: string;
          reasoning?: string;
        };
        finish_reason?: string | null;
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string; code?: unknown };
    };
    // Gateways report upstream failures (an upstream 429, say) in a 200 body.
    if (body.error)
      throw new ProviderError(
        secretRedactor.redact(body.error.message ?? 'Provider returned an error.'),
        typeof body.error.code === 'number' ? body.error.code : 400,
      );
    const choice = body.choices?.[0];
    if (!choice?.message)
      throw new HiveError('PROVIDER', 'Provider response contained no message.');
    const toolCalls = (choice.message.tool_calls ?? []).filter((call) => call?.function?.name);
    return {
      message: {
        role: 'assistant',
        content: choice.message.content ?? null,
        ...(toolCalls.length
          ? {
              tool_calls: toolCalls.map((call, index) => ({
                id: call.id || `call_${index}`,
                type: 'function' as const,
                function: { name: call.function.name, arguments: call.function.arguments ?? '{}' },
              })),
            }
          : {}),
      },
      reasoning: choice.message.reasoning_content ?? choice.message.reasoning ?? null,
      finishReason: choice.finish_reason ?? null,
      usage: body.usage
        ? {
            promptTokens: body.usage.prompt_tokens ?? 0,
            completionTokens: body.usage.completion_tokens ?? 0,
          }
        : null,
      latencyMs: Date.now() - started,
    };
  }

  /**
   * Smallest possible chat call to confirm a model really answers. Listing models is not
   * enough: providers keep retired models in the catalog while calls to them return 404.
   */
  async testModel(modelId: string, signal?: AbortSignal): Promise<{ latencyMs: number }> {
    const timeout = AbortSignal.timeout(45_000);
    const response = await this.chat(
      { model: modelId, messages: [{ role: 'user', content: 'Reply with: ok' }], maxTokens: 16 },
      signal ? AbortSignal.any([signal, timeout]) : timeout,
    );
    return { latencyMs: response.latencyMs };
  }

  /**
   * Explicit, user-triggered check of tool calling for one model. Costs a few tokens.
   * `unknown` is returned when the model answered without calling the tool: inconclusive.
   */
  async probeTools(
    modelId: string,
    signal?: AbortSignal,
  ): Promise<{ tools: 'yes' | 'no' | 'unknown'; message: string }> {
    try {
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
          maxTokens: 64,
        },
        signal,
      );
      if (response.message.tool_calls?.some((call) => call.function.name === 'ping')) {
        return { tools: 'yes', message: 'Model returned a well-formed tool call.' };
      }
      return {
        tools: 'unknown',
        message: 'Model replied without calling the tool; support is unconfirmed.',
      };
    } catch (error) {
      const message = errorMessage(error);
      if (
        error instanceof HiveError &&
        error.code === 'PROVIDER' &&
        /tool|function/i.test(message)
      ) {
        return { tools: 'no', message };
      }
      throw error;
    }
  }
}
