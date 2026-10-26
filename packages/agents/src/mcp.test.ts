import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isSafeCommand, type ExecutionLimits, type McpServer, type Worker } from '@hive/core';
import type { ChatClient, ChatRequest, ChatResponse } from '@hive/providers';
import { McpSession, formatMcpContent, qualifiedToolName } from './mcp';
import { NativeAgentRuntime } from './native-runtime';
import type { RuntimeEvent } from './runtime';

const fixture = fileURLToPath(new URL('./fixtures/echo-mcp-server.mjs', import.meta.url));

function echoServer(patch: Partial<McpServer> = {}): McpServer {
  return {
    id: 's1',
    name: 'eco',
    enabled: true,
    transport: 'stdio',
    command: process.execPath,
    args: [fixture],
    env: { HIVE_TEST_VALUE: 'segredo-do-teste' },
    url: '',
    headers: {},
    approval: 'ask',
    ...patch,
  };
}

const limits: ExecutionLimits = {
  maxSteps: 10,
  maxTokens: 100_000,
  commandTimeoutSec: 5,
  taskTimeoutMin: 1,
  temperature: null,
};

const worker = {
  id: 'w1',
  name: 'Backend',
  role: 'backend',
  systemPrompt: '',
  tools: [],
  squad: [],
  autoApproveCommands: [],
  mcpServers: ['s1'],
} as unknown as Worker;

/** A model that calls one tool, then finishes with the result it got back. */
function callingChat(tool: string, args: Record<string, unknown>, requests: ChatRequest[]) {
  return {
    async chat(request: ChatRequest): Promise<ChatResponse> {
      requests.push(request);
      const last = request.messages.at(-1)!;
      const call =
        last.role === 'tool'
          ? { name: 'finish', arguments: JSON.stringify({ summary: last.content, success: true }) }
          : { name: tool, arguments: JSON.stringify(args) };
      return {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: `c${requests.length}`, type: 'function', function: call }],
        },
        reasoning: null,
        finishReason: 'tool_calls',
        usage: null,
        latencyMs: 1,
      };
    },
  } as ChatClient;
}

async function runWith(servers: McpServer[], chat: ChatClient, approve: boolean) {
  const worktree = await mkdtemp(path.join(os.tmpdir(), 'hive-mcp-'));
  const runtime = new NativeAgentRuntime({ mcpServers: () => servers });
  const approvals: string[] = [];
  const events: RuntimeEvent[] = [];
  const sessionId = `mcp-${Math.random()}`;
  const session = await runtime.start({
    sessionId,
    task: {
      title: 'Usar MCP',
      description: 'Chame a ferramenta.',
      acceptanceCriteria: [],
      upstream: [],
    },
    worker,
    model: 'test-model',
    chat,
    worktreePath: worktree,
    skills: [],
    limits,
    requestApproval: async ({ command }) => {
      approvals.push(command);
      return approve;
    },
  });
  runtime.subscribe(sessionId, (event) => events.push(event));
  return { outcome: await session.done, approvals, events };
}

describe('cliente MCP', () => {
  it('conecta por stdio, lista as ferramentas e chama com o ambiente configurado', async () => {
    const session = await McpSession.open(
      [echoServer()],
      os.tmpdir(),
      new AbortController().signal,
    );
    try {
      expect(session.failures).toEqual([]);
      expect(session.tools.map((tool) => tool.qualified)).toEqual([
        'mcp__eco__echo',
        'mcp__eco__env',
        'mcp__eco__fail',
      ]);
      expect(session.tools[0]!.definition.function.description).toBe('[MCP eco] Repeats the text.');
      const echo = await session.call(
        session.tools[0]!,
        { text: 'oi' },
        new AbortController().signal,
      );
      expect(echo).toMatchObject({ text: 'eco: oi', isError: false });
      const env = await session.call(session.tools[1]!, {}, new AbortController().signal);
      expect(env.text).toBe('segredo-do-teste');
      const fail = await session.call(session.tools[2]!, {}, new AbortController().signal);
      expect(fail.isError).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('registra o servidor que não sobe, sem derrubar os outros', async () => {
    const broken = echoServer({
      id: 's2',
      name: 'quebrado',
      command: 'comando-que-nao-existe-hive',
    });
    const session = await McpSession.open(
      [echoServer(), broken],
      os.tmpdir(),
      new AbortController().signal,
    );
    try {
      expect(session.failures.map((failure) => failure.server)).toEqual(['quebrado']);
      expect(session.tools).toHaveLength(3);
    } finally {
      await session.close();
    }
  });

  it('dá nomes de ferramenta que as APIs aceitam', () => {
    expect(qualifiedToolName('github', 'issues.create')).toBe('mcp__github__issues_create');
    expect(qualifiedToolName('x', 'a'.repeat(100))).toHaveLength(64);
  });

  it('separa as imagens do texto do resultado', () => {
    const content = formatMcpContent([
      { type: 'text', text: 'olá' },
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
    ]);
    expect(content.text).toBe('olá\n[image image/png]');
    expect(content.images).toEqual([{ mime: 'image/png', data: 'AAAA' }]);
  });
});

describe('MCP no runtime dos agentes', () => {
  it('pede aprovação como um comando e devolve o resultado ao modelo', async () => {
    const requests: ChatRequest[] = [];
    const { outcome, approvals } = await runWith(
      [echoServer()],
      callingChat('mcp__eco__echo', { text: 'colmeia' }, requests),
      true,
    );
    expect(outcome.status).toBe('completed');
    expect(outcome.summary).toBe('eco: colmeia');
    expect(approvals).toEqual(['mcp eco echo {"text":"colmeia"}']);
    expect(requests[0]!.tools!.map((tool) => tool.function.name)).toContain('mcp__eco__echo');
    // Read-only commands may pass on their own; an MCP call never counts as one.
    expect(isSafeCommand(approvals[0]!)).toBe(false);
  });

  it('respeita a recusa do usuário', async () => {
    const { outcome } = await runWith(
      [echoServer()],
      callingChat('mcp__eco__echo', { text: 'x' }, []),
      false,
    );
    expect(outcome.summary).toContain('The user denied this MCP call');
  });

  it('não pergunta nada a um servidor confiável', async () => {
    const { outcome, approvals } = await runWith(
      [echoServer({ approval: 'auto' })],
      callingChat('mcp__eco__echo', { text: 'direto' }, []),
      false,
    );
    expect(outcome.summary).toBe('eco: direto');
    expect(approvals).toEqual([]);
  });

  it('só dá ao agente os servidores ligados que ele escolheu', async () => {
    const requests: ChatRequest[] = [];
    await runWith(
      [echoServer({ enabled: false }), echoServer({ id: 'outro', name: 'outro' })],
      callingChat('finish', { summary: 'nada', success: true }, requests),
      true,
    );
    const names = requests[0]!.tools!.map((tool) => tool.function.name);
    expect(names.some((name) => name.startsWith('mcp__'))).toBe(false);
  });
});
