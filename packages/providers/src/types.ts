import type { ProviderKind } from '@hive/core';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number | null;
  maxTokens?: number;
  /** Ask for a JSON object response, where the provider supports it. */
  jsonMode?: boolean;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatResponse {
  message: Extract<ChatMessage, { role: 'assistant' }>;
  /** Reasoning text some models return separately (e.g. `reasoning_content`). */
  reasoning: string | null;
  finishReason: string | null;
  usage: ChatUsage | null;
  latencyMs: number;
}

export interface ProviderEndpoint {
  providerId: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string | null;
}

/** What the runtime needs from a provider; lets tests substitute a scripted model. */
export interface ChatClient {
  chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
}
