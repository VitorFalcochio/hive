import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutionLimits, Worker } from '@hive/core';
import type { ChatClient } from '@hive/providers';
import { ClaudeCodeRuntime } from './claude-code';
import type { AgentTaskInput, RuntimeEvent } from './runtime';

const fake = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-claude-code.mjs',
);
const limits: ExecutionLimits = {
  maxSteps: 7,
  maxTokens: 100_000,
  commandTimeoutSec: 5,
  taskTimeoutMin: 1,
  temperature: null,
};
const worker = {
  id: 'w1',
  name: 'Arquiteta',
  role: 'architect',
  systemPrompt: 'Você desenha a base.',
} as unknown as Worker;

async function setup(env: Record<string, string> = {}, options: { allowCommands?: boolean } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hive-claude-'));
  const record = path.join(dir, '..', `${path.basename(dir)}-record.json`);
  Object.assign(process.env, { FAKE_CLAUDE_RECORD: record, ...env });
  const runtime = new ClaudeCodeRuntime({
    executable: process.execPath,
    argsPrefix: [fake],
    allowCommands: () => options.allowCommands ?? false,
  });
  const input: AgentTaskInput = {
    sessionId: `s-${path.basename(dir)}`,
    task: {
      title: 'Criar hello',
      description: 'Crie hello.txt.',
      acceptanceCriteria: ['hello.txt existe'],
      upstream: [],
    },
    worker,
    model: 'sonnet',
    chat: {} as ChatClient,
    worktreePath: dir,
    skills: [],
    limits,
    requestApproval: async () => false,
  };
  return { dir, record, runtime, input };
}

afterEach(() => {
  for (const name of [
    'FAKE_CLAUDE_MODE',
    'FAKE_CLAUDE_AUTH',
    'FAKE_CLAUDE_RECORD',
    'ANTHROPIC_API_KEY',
  ])
    delete process.env[name];
});

describe('Claude Code como motor do Hive', { timeout: 30_000 }, () => {
  it('envia a tarefa, traduz o stream JSON em eventos e devolve resultado e consumo', async () => {
    const { dir, record, runtime, input } = await setup({ ANTHROPIC_API_KEY: 'sk-nao-deve-vazar' });
    const session = await runtime.start(input);
    const events: RuntimeEvent[] = [];
    runtime.subscribe(session.id, (event) => events.push(event));
    const outcome = await session.done;

    expect(outcome).toMatchObject({
      status: 'completed',
      summary: 'Criei hello.txt e rodei npm test.',
      error: null,
      usage: { promptTokens: 150, completionTokens: 40 },
    });
    expect(outcome.commands).toMatchObject([
      { command: 'npm test', exitCode: null, outputTail: '1 passed' },
    ]);
    expect(existsSync(path.join(dir, 'hello.txt'))).toBe(true);
    const types = events.map((event) => event.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'session.started',
        'model.response',
        'tool.call',
        'file.changed',
        'command.started',
        'command.finished',
        'tool.result',
        'session.finished',
      ]),
    );
    expect(events.find((event) => event.type === 'file.changed')?.data).toMatchObject({
      path: 'hello.txt',
    });
    // A line outside the protocol is reported, not silently dropped.
    expect(events.some((event) => event.message.includes('isto não é json'))).toBe(true);

    const started = JSON.parse(await readFile(record, 'utf8'));
    expect(started.prompt).toContain('# Task: Criar hello');
    expect(started.prompt).toContain('Você desenha a base.');
    expect(path.resolve(started.cwd)).toBe(path.resolve(dir));
    expect(started.apiKey).toBeNull();
    const args: string[] = started.args;
    expect(args.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose']);
    expect(args).toEqual(
      expect.arrayContaining([
        '--permission-prompts',
        'none',
        '--max-turns',
        '7',
        '--model',
        'sonnet',
      ]),
    );
    expect(args.slice(args.indexOf('--disallowedTools'))).toEqual([
      '--disallowedTools',
      'Bash',
      'PowerShell',
    ]);
  });

  it('libera comandos só quando a configuração do Hive já libera todos', async () => {
    const { record, runtime, input } = await setup({}, { allowCommands: true });
    await (
      await runtime.start(input)
    ).done;
    const { args } = JSON.parse(await readFile(record, 'utf8'));
    expect(args).toEqual(expect.arrayContaining(['--allowedTools', 'Bash', 'PowerShell']));
    expect(args).not.toContain('--disallowedTools');
  });

  it('trava de custo: não inicia com login por chave de API', async () => {
    const { record, runtime, input } = await setup({ FAKE_CLAUDE_AUTH: 'console' });
    const outcome = await (await runtime.start(input)).done;
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('Trava de custo');
    expect(existsSync(record)).toBe(false);
  });

  it('limite de turnos vira falha explicada', async () => {
    const { runtime, input } = await setup({ FAKE_CLAUDE_MODE: 'max-turns' });
    const outcome = await (await runtime.start(input)).done;
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('error_max_turns');
    expect(outcome.usage).toEqual({ promptTokens: 10, completionTokens: 2 });
  });

  it('processo que cai sem resultado traz o stderr na falha', async () => {
    const { runtime, input } = await setup({ FAKE_CLAUDE_MODE: 'crash' });
    const outcome = await (await runtime.start(input)).done;
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('código 3');
    expect(outcome.error).toContain('falha interna simulada');
  });

  it('cancelar encerra o processo e devolve cancelada', async () => {
    const { record, runtime, input } = await setup({ FAKE_CLAUDE_MODE: 'hang' });
    const session = await runtime.start(input);
    const deadline = Date.now() + 10_000;
    while (!existsSync(record) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    await runtime.cancel(session.id);
    const outcome = await session.done;
    expect(outcome.status).toBe('cancelled');
  });

  it('tempo limite encerra o processo e falha com o motivo', async () => {
    const { runtime, input } = await setup({ FAKE_CLAUDE_MODE: 'hang' });
    const outcome = await (
      await runtime.start({ ...input, limits: { ...limits, taskTimeoutMin: 0.03 } })
    ).done;
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('Tempo limite');
  });
});

describe('aprovações do Hive para o Claude Code', { timeout: 30_000 }, () => {
  it('cada pedido de permissão vira uma aprovação do Hive, liberada ou negada', async () => {
    const { ClaudeCodePermissions, PERMISSION_TOOL } = await import('./claude-code-permissions');
    const permissions = new ClaudeCodePermissions();
    try {
      for (const allow of [true, false]) {
        const { record, input } = await setup({ FAKE_CLAUDE_MODE: 'permission' });
        const runtime = new ClaudeCodeRuntime({
          executable: process.execPath,
          argsPrefix: [fake],
          permissions,
        });
        const asked: string[] = [];
        const outcome = await (
          await runtime.start({
            ...input,
            requestApproval: async ({ command }) => {
              asked.push(command);
              return allow;
            },
          })
        ).done;
        expect(outcome.status).toBe('completed');
        expect(asked).toEqual(['npm test']);
        const reply = JSON.parse(outcome.summary);
        expect(reply.tools).toEqual(['approve']);
        expect(reply.decision).toEqual(
          allow
            ? { behavior: 'allow', updatedInput: { command: 'npm test' } }
            : { behavior: 'deny', message: 'O usuário do Hive não liberou esta ação.' },
        );
        const { args } = JSON.parse(await readFile(record, 'utf8'));
        expect(args).toEqual(
          expect.arrayContaining([
            '--permission-prompt-tool',
            PERMISSION_TOOL,
            '--strict-mcp-config',
          ]),
        );
        expect(args).not.toContain('--permission-prompts');
      }
    } finally {
      await permissions.close();
    }
  });

  it('sem token válido, o servidor recusa', async () => {
    const { ClaudeCodePermissions } = await import('./claude-code-permissions');
    const permissions = new ClaudeCodePermissions();
    try {
      const { config, release } = await permissions.register(async () => ({
        behavior: 'deny',
        message: 'x',
      }));
      const { url } = JSON.parse(config).mcpServers.hive;
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer errado', 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(401);
      release();
    } finally {
      await permissions.close();
    }
  });
});

describe('Claude Code como provedor (texto)', { timeout: 30_000 }, () => {
  async function client(env: Record<string, string> = {}) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hive-claude-chat-'));
    const record = path.join(dir, 'record.json');
    Object.assign(process.env, { FAKE_CLAUDE_RECORD: record, ...env });
    const { ClaudeCodePlanClient } = await import('./claude-code-chat');
    return {
      record,
      chat: new ClaudeCodePlanClient({
        providerId: 'p',
        executable: process.execPath,
        argsPrefix: [fake],
      }),
    };
  }

  it('responde texto sem ferramentas, com a conversa e o consumo', async () => {
    const { record, chat } = await client({ ANTHROPIC_API_KEY: 'sk-nao-deve-vazar' });
    const response = await chat.chat({
      model: 'sonnet',
      messages: [
        { role: 'system', content: 'Você é a Queen.' },
        { role: 'user', content: 'Planeje.' },
        { role: 'assistant', content: 'Isso não era JSON.' },
        { role: 'user', content: 'Responda só com o JSON.' },
      ],
      jsonMode: true,
    });
    expect(response.message.content).toContain('eco:');
    expect(response.usage).toEqual({ promptTokens: 15, completionTokens: 5, cachedTokens: 3 });
    const started = JSON.parse(await readFile(record, 'utf8'));
    expect(started.apiKey).toBeNull();
    expect(started.prompt).toContain('<instructions>\nVocê é a Queen.');
    expect(started.prompt).toContain('[assistant]\nIsso não era JSON.');
    expect(started.prompt).toContain('only one JSON object');
    expect(started.args).toEqual(
      expect.arrayContaining([
        '-p',
        '--output-format',
        'json',
        '--tools',
        '',
        '--strict-mcp-config',
        '--max-turns',
        '1',
        '--model',
        'sonnet',
      ]),
    );
  });

  it('recusa pedidos com ferramentas do Hive e explica para onde vão', async () => {
    const { chat } = await client();
    await expect(
      chat.chat({
        model: 'default',
        messages: [{ role: 'user', content: 'x' }],
        tools: [
          { type: 'function', function: { name: 'read_file', description: '', parameters: {} } },
        ],
      }),
    ).rejects.toThrow('motor Claude Code');
  });

  it('trava de custo e limite do plano viram erros que o failover entende', async () => {
    const lock = await client({ FAKE_CLAUDE_AUTH: 'console' });
    await expect(
      lock.chat.chat({ model: 'default', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining('Trava de custo'),
    });
    delete process.env.FAKE_CLAUDE_AUTH;
    const limited = await client({ FAKE_CLAUDE_MODE: 'limit' });
    await expect(
      limited.chat.chat({ model: 'default', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({
      status: 429,
    });
  });

  it('catálogo e teste de conexão não gastam a cota', async () => {
    const { record, chat } = await client();
    const test = await chat.testConnection();
    expect(test.modelCount).toBe(4);
    const models = await chat.listModels();
    expect(models.map((model) => model.id)).toEqual(['default', 'sonnet', 'opus', 'haiku']);
    expect(models.every((model) => model.pricing?.inputPerMTok === 0)).toBe(true);
    expect((await chat.account()).authMethod).toBe('claude.ai');
    // Only `auth status` ran: no prompt was ever sent.
    expect(existsSync(record)).toBe(false);
  });
});
