import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecutionLimits, Worker } from '@hive/core';
import type { ChatClient, ChatRequest, ChatResponse } from '@hive/providers';
import { NativeAgentRuntime } from './native-runtime';

const limits: ExecutionLimits = {
  maxSteps: 20,
  maxTokens: 100_000,
  commandTimeoutSec: 5,
  taskTimeoutMin: 1,
  temperature: null,
};

const worker = {
  id: 'w1',
  name: 'Analista',
  role: 'code',
  systemPrompt: 'Você analisa o projeto.',
  tools: ['read_file'],
} as unknown as Worker;

function readingChat(requests: ChatRequest[]): ChatClient {
  return {
    async chat(request: ChatRequest): Promise<ChatResponse> {
      requests.push(request);
      if (!request.tools) {
        return {
          message: { role: 'assistant', content: 'Resumo final.' },
          reasoning: null,
          finishReason: 'stop',
          usage: null,
          latencyMs: 1,
        };
      }
      return {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: `call-${requests.length}`,
              type: 'function',
              function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) },
            },
          ],
        },
        reasoning: null,
        finishReason: 'tool_calls',
        usage: { promptTokens: 30_000, completionTokens: 100 },
        latencyMs: 1,
      };
    },
  } as ChatClient;
}

describe('NativeAgentRuntime token budget', () => {
  it('asks for a final summary without tools before the budget runs out', async () => {
    const worktree = await mkdtemp(path.join(os.tmpdir(), 'hive-budget-'));
    await writeFile(path.join(worktree, 'a.txt'), 'conteúdo');
    const requests: ChatRequest[] = [];
    const runtime = new NativeAgentRuntime();
    const session = await runtime.start({
      sessionId: 'budget-test',
      task: {
        title: 'Analisar',
        description: 'Leia o projeto.',
        acceptanceCriteria: [],
        upstream: [],
      },
      worker,
      model: 'test-model',
      chat: readingChat(requests),
      worktreePath: worktree,
      skills: [],
      limits,
      requestApproval: async () => false,
    });
    const outcome = await session.done;

    expect(outcome.status).toBe('completed');
    expect(outcome.summary).toContain('Resumo final.');
    expect(outcome.summary).toContain('Encerrado ao atingir o limite');
    const last = requests[requests.length - 1]!;
    expect(last.tools).toBeUndefined();
    expect(
      last.messages.some(
        (message) => message.role === 'user' && String(message.content).includes('token budget'),
      ),
    ).toBe(true);
  });
});
