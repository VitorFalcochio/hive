import { describe, expect, it, vi } from 'vitest';
import { defaultLimits, type Worker } from '@hive/core';
import type { ChatClient, ChatRequest } from '@hive/providers';
import { assistCode, parseAssistantReply } from './code-assistant';

const worker: Worker & { providerId: string; modelId: string } = {
  id: 'worker-reviewer',
  name: 'Reviewer',
  role: 'reviewer',
  description: 'Revisa código.',
  providerId: 'provider-1',
  modelId: 'model-1',
  skills: [],
  tools: [],
  autoApproveCommands: [],
  systemPrompt: 'Priorize correção e clareza.',
  limits: { ...defaultLimits },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function input() {
  return {
    workerId: worker.id,
    mode: 'edit' as const,
    path: 'src/math.ts',
    fileContent: 'export const sum = (a, b) => a + b;\n',
    selection: { startOffset: 19, endOffset: 34, text: '(a, b) => a + b' },
    instruction: 'Adicione tipos TypeScript.',
    history: [],
  };
}

describe('assistente de código', () => {
  it('transforma uma resposta estruturada em proposta sem alterar o arquivo', async () => {
    let captured: ChatRequest | undefined;
    const chat = {
      chat: vi.fn(async (request: ChatRequest) => {
        captured = request;
        return {
          message: {
            role: 'assistant' as const,
            content: JSON.stringify({
              answer: 'Adicionei tipos numéricos.',
              replacement: '(a: number, b: number) => a + b',
              summary: 'Tipar os parâmetros',
            }),
          },
          reasoning: null,
          finishReason: 'stop',
          usage: { promptTokens: 30, completionTokens: 12 },
          latencyMs: 10,
        };
      }),
    } satisfies ChatClient;

    const result = await assistCode(chat, worker, input());
    expect(result.proposal).toEqual({
      replacement: '(a: number, b: number) => a + b',
      summary: 'Tipar os parâmetros',
    });
    expect(result.worker.modelId).toBe('model-1');
    expect(chat.chat).toHaveBeenCalledOnce();
    expect(captured?.jsonMode).toBeUndefined();
    expect(JSON.stringify(captured?.messages)).toContain('src/math.ts');
  });

  it('recusa uma seleção que já não corresponde ao conteúdo atual', async () => {
    const chat = { chat: vi.fn() } as unknown as ChatClient;
    await expect(
      assistCode(chat, worker, {
        ...input(),
        selection: { startOffset: 19, endOffset: 34, text: 'trecho antigo' },
      }),
    ).rejects.toThrow('mudou depois');
    expect(chat.chat).not.toHaveBeenCalled();
  });

  it('aceita texto simples como explicação, sem criar proposta', () => {
    expect(
      parseAssistantReply('Este trecho soma dois valores.', { mode: 'explain', selection: null }),
    ).toEqual({ answer: 'Este trecho soma dois valores.', proposal: null });
  });
});
