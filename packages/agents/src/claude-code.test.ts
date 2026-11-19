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
