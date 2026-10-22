import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { soldierRoles, type ExecutionLimits, type Worker } from '@hive/core';
import type { ChatClient, ChatRequest, ChatResponse } from '@hive/providers';
import { ProviderError } from '@hive/providers';
import { compactToolOutputs, NativeAgentRuntime } from './native-runtime';
import type { RuntimeEvent } from './runtime';

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

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** A model that reads `logo.png`, then finishes; `blind` models reject any image. */
function lookingChat(requests: ChatRequest[], blind = false): ChatClient {
  const reply = (message: ChatResponse['message']): ChatResponse => ({
    message,
    reasoning: null,
    finishReason: 'stop',
    usage: null,
    latencyMs: 1,
  });
  const call = (name: string, args: unknown) => ({
    role: 'assistant' as const,
    content: '',
    tool_calls: [
      {
        id: `c${requests.length}`,
        type: 'function' as const,
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
  return {
    async chat(request: ChatRequest): Promise<ChatResponse> {
      const withImage = request.messages.some(
        (message) =>
          Array.isArray(message.content) &&
          message.content.some((part) => part.type === 'image_url'),
      );
      if (blind && withImage)
        throw new ProviderError(
          'Provider error 400. This model does not support image input.',
          400,
        );
      requests.push(structuredClone(request));
      const read = request.messages.some((message) => message.role === 'tool');
      return reply(
        read
          ? call('finish', { summary: 'Vi a imagem.', success: true })
          : call('read_file', { path: 'logo.png' }),
      );
    },
  } as ChatClient;
}

async function lookAtLogo(chat: ChatClient) {
  const worktree = await mkdtemp(path.join(os.tmpdir(), 'hive-vision-'));
  await writeFile(path.join(worktree, 'logo.png'), PNG);
  const session = await new NativeAgentRuntime().start({
    sessionId: `vision-${Math.random()}`,
    task: { title: 'Olhar', description: 'Veja o logo.', acceptanceCriteria: [], upstream: [] },
    worker,
    model: 'test-model',
    chat,
    worktreePath: worktree,
    skills: [],
    limits,
    requestApproval: async () => false,
  });
  return session.done;
}

describe('NativeAgentRuntime vision', () => {
  it('shows an image read with read_file to the model, after the tool results', async () => {
    const requests: ChatRequest[] = [];
    const outcome = await lookAtLogo(lookingChat(requests));

    expect(outcome.status).toBe('completed');
    const messages = requests[1]!.messages;
    const toolIndex = messages.findIndex((message) => message.role === 'tool');
    expect(String(messages[toolIndex]!.content)).toContain('attached in the next message');
    const attached = messages[toolIndex + 1]!;
    expect(attached.role).toBe('user');
    expect(attached.content).toEqual([
      { type: 'text', text: 'Image logo.png:' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } },
    ]);
  });

  it('goes on without the image when the model cannot see', async () => {
    const requests: ChatRequest[] = [];
    const outcome = await lookAtLogo(lookingChat(requests, true));

    expect(outcome.status).toBe('completed');
    const last = JSON.stringify(requests[requests.length - 1]!.messages);
    expect(last).not.toContain('image_url');
    expect(last).toContain('does not accept images');
  });
});

describe('NativeAgentRuntime provider trouble', () => {
  it('waits out a rate limit and finishes the task', async () => {
    let calls = 0;
    const chat = {
      async chat(): Promise<ChatResponse> {
        calls++;
        if (calls === 1) throw new ProviderError('Rate limited or out of quota (429).', 429, 5);
        return {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'finish', arguments: JSON.stringify({ summary: 'Feito.' }) },
              },
            ],
          },
          reasoning: null,
          finishReason: 'tool_calls',
          usage: null,
          latencyMs: 1,
        };
      },
    } as ChatClient;
    const worktree = await mkdtemp(path.join(os.tmpdir(), 'hive-retry-'));
    const runtime = new NativeAgentRuntime();
    const events: string[] = [];
    const session = await runtime.start({
      sessionId: 'retry-test',
      task: { title: 'Tentar', description: 'Termine.', acceptanceCriteria: [], upstream: [] },
      worker,
      model: 'test-model',
      chat,
      worktreePath: worktree,
      skills: [],
      limits,
      requestApproval: async () => false,
    });
    runtime.subscribe('retry-test', (event) =>
      events.push(String(event.data?.state ?? event.message)),
    );
    const outcome = await session.done;

    expect(outcome.status).toBe('completed');
    expect(outcome.summary).toBe('Feito.');
    expect(calls).toBe(2);
    expect(events).toContain('waiting_provider');
    expect(events.some((text) => text.includes('Nova tentativa'))).toBe(true);
  });
});

describe('NativeAgentRuntime token savings', () => {
  it('ends a terminal turn on a plain-text reply, in one paid step', async () => {
    const requests: ChatRequest[] = [];
    const chat = {
      async chat(request: ChatRequest): Promise<ChatResponse> {
        requests.push(request);
        return {
          message: { role: 'assistant', content: 'Olá! Como posso ajudar?' },
          reasoning: null,
          finishReason: 'stop',
          usage: { promptTokens: 500, completionTokens: 20 },
          latencyMs: 1,
        };
      },
    } as ChatClient;
    const worktree = await mkdtemp(path.join(os.tmpdir(), 'hive-chat-'));
    const session = await new NativeAgentRuntime().start({
      sessionId: 'chat-test',
      task: { title: 'Olá!', description: 'Olá!', acceptanceCriteria: [], upstream: [] },
      worker,
      model: 'test-model',
      chat,
      worktreePath: worktree,
      place: 'project',
      skills: [],
      limits,
      requestApproval: async () => false,
    });
    const outcome = await session.done;
    expect(outcome).toMatchObject({ status: 'completed', summary: 'Olá! Como posso ajudar?' });
    expect(requests).toHaveLength(1);
  });

  it('shortens long tool outputs from older steps, once', () => {
    const long = 'x'.repeat(5_000);
    const step = (id: string): ChatRequest['messages'] => [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: id, content: long },
    ];
    const messages: ChatRequest['messages'] = [
      { role: 'system', content: 's' },
      ...step('a'),
      ...step('b'),
      ...step('c'),
    ];
    compactToolOutputs(messages, 2);
    const outputs = messages.filter((message) => message.role === 'tool').map((m) => m.content);
    expect(outputs[0]!.length).toBeLessThan(600);
    expect(outputs[0]).toContain('call the tool again');
    expect(outputs[1]).toBe(long);
    expect(outputs[2]).toBe(long);
    const once = outputs[0];
    compactToolOutputs(messages, 2);
    expect(messages[2]!.content).toBe(once);
  });
});

/** The captain calls `assignments` first and finishes with what the soldiers reported. */
function squadChat(
  requests: ChatRequest[],
  assignments: unknown,
  tracker = { active: 0, most: 0 },
) {
  const reply = (message: ChatResponse['message']): ChatResponse => ({
    message,
    reasoning: null,
    finishReason: 'stop',
    usage: { promptTokens: 10, completionTokens: 5 },
    latencyMs: 1,
  });
  const call = (name: string, args: unknown) => ({
    role: 'assistant' as const,
    content: '',
    tool_calls: [
      {
        id: `c${requests.length}`,
        type: 'function' as const,
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
  return {
    async chat(request: ChatRequest): Promise<ChatResponse> {
      requests.push(structuredClone(request));
      const system = String(request.messages[0]!.content);
      if (system.includes("in Analista's squad")) {
        tracker.active++;
        tracker.most = Math.max(tracker.most, tracker.active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        tracker.active--;
        const role = /You are the (\w+) bee/.exec(system)![1];
        return reply({ role: 'assistant', content: `Relatório da ${role}.` });
      }
      const report = request.messages.find((message) => message.role === 'tool');
      return report
        ? reply(call('finish', { summary: String(report.content), success: true }))
        : reply(call('call_soldiers', { assignments }));
    },
  } as ChatClient;
}

async function lead(chat: ChatClient, captain: Worker) {
  const worktree = await mkdtemp(path.join(os.tmpdir(), 'hive-squad-'));
  const runtime = new NativeAgentRuntime();
  const sessionId = `squad-${Math.random()}`;
  const session = await runtime.start({
    sessionId,
    task: {
      title: 'Entender',
      description: 'Explique o projeto.',
      acceptanceCriteria: [],
      upstream: [],
    },
    worker: captain,
    model: 'captain-model',
    chat,
    worktreePath: worktree,
    skills: [],
    limits,
    requestApproval: async () => false,
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribe(sessionId, (event) => events.push(event));
  return { outcome: await session.done, events };
}

describe('NativeAgentRuntime squad', () => {
  const captain = {
    ...worker,
    tools: ['list_dir', 'read_file', 'search', 'write_file', 'run_command'],
    squad: [],
  } as unknown as Worker;

  it('calls only the soldiers asked for, in parallel, and hands their reports back', async () => {
    const requests: ChatRequest[] = [];
    const tracker = { active: 0, most: 0 };
    const { outcome, events } = await lead(
      squadChat(
        requests,
        [
          { role: 'scout', instruction: 'Ache os pontos de entrada.' },
          { role: 'researcher', instruction: 'Leia a documentação.' },
        ],
        tracker,
      ),
      captain,
    );

    expect(outcome.status).toBe('completed');
    expect(outcome.summary).toContain('Relatório da scout.');
    expect(outcome.summary).toContain('Relatório da researcher.');
    expect(tracker.most).toBe(2);
    const soldiers = requests.filter((r) =>
      String(r.messages[0]!.content).includes("in Analista's squad"),
    );
    expect(soldiers).toHaveLength(2);
    // A scout only looks, even though her captain can write and run commands.
    const scout = soldiers.find((r) => String(r.messages[0]!.content).includes('scout bee'))!;
    expect(scout.tools!.map((tool) => tool.function.name)).toEqual([
      'list_dir',
      'read_file',
      'search',
      'finish',
    ]);
    expect(scout.messages[1]).toEqual({ role: 'user', content: 'Ache os pontos de entrada.' });
    expect(
      events.some((e) => e.data?.soldier === 'scout' && e.message.startsWith('Batedora:')),
    ).toBe(true);
    // Soldiers' tokens count against the task's budget.
    expect(outcome.usage.promptTokens).toBe(40);
  });

  it('refuses two soldiers that change the worktree in one call', async () => {
    const requests: ChatRequest[] = [];
    const { outcome } = await lead(
      squadChat(requests, [
        { role: 'builder', instruction: 'Edite a.ts.' },
        { role: 'tester', instruction: 'Rode os testes.' },
      ]),
      captain,
    );

    expect(outcome.summary).toContain('at most one soldier that edits files or runs commands');
    expect(
      requests.some((r) => String(r.messages[0]!.content).includes("in Analista's squad")),
    ).toBe(false);
  });

  it('offers only enabled soldiers, on their own model when they have one', async () => {
    const requests: ChatRequest[] = [];
    const { outcome } = await lead(
      squadChat(requests, [{ role: 'reviewer', instruction: 'Revise.' }]),
      {
        ...captain,
        squad: [
          { role: 'scout', enabled: false, modelId: null },
          { role: 'reviewer', enabled: true, modelId: 'small-model' },
        ],
      },
    );

    expect(outcome.status).toBe('completed');
    const offered = requests[0]!.tools!.find((tool) => tool.function.name === 'call_soldiers')!;
    expect(JSON.stringify(offered)).not.toContain('"scout"');
    const reviewer = requests.find((r) => String(r.messages[0]!.content).includes('reviewer bee'))!;
    expect(reviewer.model).toBe('small-model');
  });

  it('accepts the assignments sent as a JSON string', async () => {
    const requests: ChatRequest[] = [];
    const { outcome } = await lead(
      squadChat(requests, JSON.stringify([{ role: 'scout', instruction: 'Explore.' }])),
      captain,
    );

    expect(outcome.summary).toContain('Relatório da scout.');
  });

  it('gives no squad to an agent whose soldiers are all off', async () => {
    const requests: ChatRequest[] = [];
    await lead(squadChat(requests, []), {
      ...captain,
      squad: soldierRoles.map((role) => ({ role, enabled: false, modelId: null })),
    });

    expect(requests[0]!.tools!.some((tool) => tool.function.name === 'call_soldiers')).toBe(false);
    expect(String(requests[0]!.messages[0]!.content)).not.toContain('## Your squad');
  });
});
