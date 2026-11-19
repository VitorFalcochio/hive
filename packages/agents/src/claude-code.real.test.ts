import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Worker } from '@hive/core';
import type { ChatClient } from '@hive/providers';
import { ClaudeCodeRuntime, findClaudeCode } from './claude-code';
import type { RuntimeEvent } from './runtime';

/**
 * The adapter against the real Claude Code. It uses the plan quota of the signed-in claude.ai
 * account, so it runs only when asked: `HIVE_REAL_CLAUDE=1 npx vitest run claude-code.real`.
 */
describe.runIf(process.env.HIVE_REAL_CLAUDE === '1')('Claude Code real', () => {
  it(
    'cria um arquivo pedido pelo Hive e devolve resultado e consumo',
    { timeout: 240_000 },
    async () => {
      const executable = findClaudeCode();
      expect(executable).not.toBeNull();
      const dir = await mkdtemp(path.join(os.tmpdir(), 'hive-claude-real-'));
      const runtime = new ClaudeCodeRuntime({
        executable: executable!,
        allowCommands: () => false,
      });
      const session = await runtime.start({
        sessionId: 'real-1',
        task: {
          title: 'Criar ola.txt',
          description: 'Crie o arquivo ola.txt com exatamente o texto: Hive + Claude Code',
          acceptanceCriteria: ['ola.txt contém exatamente "Hive + Claude Code"'],
          upstream: [],
        },
        worker: { id: 'w', name: 'Executor', systemPrompt: '' } as unknown as Worker,
        model: 'default',
        chat: {} as ChatClient,
        worktreePath: dir,
        skills: [],
        limits: {
          maxSteps: 3,
          maxTokens: 50_000,
          commandTimeoutSec: 30,
          taskTimeoutMin: 3,
          temperature: null,
        },
        requestApproval: async () => false,
      });
      const events: RuntimeEvent[] = [];
      runtime.subscribe(session.id, (event) => events.push(event));
      const outcome = await session.done;
      console.log(
        JSON.stringify(
          {
            outcome,
            events: events.map((e) => `${e.type}: ${e.message.slice(0, 120)}`),
            finished: events.find((e) => e.type === 'session.finished')?.data,
          },
          null,
          2,
        ),
      );
      expect(outcome.status).toBe('completed');
      expect(existsSync(path.join(dir, 'ola.txt'))).toBe(true);
      expect((await readFile(path.join(dir, 'ola.txt'), 'utf8')).trim()).toBe('Hive + Claude Code');
      expect(outcome.usage.completionTokens).toBeGreaterThan(0);
    },
  );
});

describe.runIf(process.env.HIVE_REAL_CLAUDE === '1')('Claude Code real como provedor', () => {
  it('responde um pedido de texto pela conta claude.ai', { timeout: 120_000 }, async () => {
    const { ClaudeCodePlanClient } = await import('./claude-code-chat');
    const client = new ClaudeCodePlanClient({ providerId: 'p', executable: findClaudeCode()! });
    const response = await client.chat({
      model: 'default',
      messages: [
        { role: 'system', content: 'Answer in one word.' },
        { role: 'user', content: 'Reply with exactly: ok' },
      ],
    });
    expect(response.message.content?.toLowerCase()).toContain('ok');
    expect(response.usage?.completionTokens).toBeGreaterThan(0);
  });
});
