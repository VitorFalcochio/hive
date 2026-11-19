import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ContextMode, ExecutionLimits, Worker } from '@hive/core';
import type { ChatClient, ChatRequest, ChatResponse } from '@hive/providers';
import { NativeAgentRuntime } from '../native-runtime';

/*
 * The 'legacy' mode must send the model exactly what Hive sent before the Context Shield
 * existed. The reference file was recorded from Hive 0.2.3 (commit 53ed093) running this same
 * scenario, which goes through every way the token saver changes a prompt: an unchanged re-read,
 * a re-read sent as a diff, long command outputs condensed, read_output, older outputs
 * shortened after three steps and the loop warning. Any change to what the model
 * receives in 'legacy' fails here; if one is ever intended, it needs a new reference on purpose.
 */

const limits: ExecutionLimits = {
  maxSteps: 30,
  maxTokens: 10_000_000,
  commandTimeoutSec: 20,
  taskTimeoutMin: 2,
  temperature: null,
};

type Call = { name: string; args: Record<string, unknown> };

const read = { name: 'read_file', args: { path: 'a.txt' } };
const failing = { name: 'run_command', args: { command: 'node falha.js' } };
const scenario: Call[] = [
  { name: 'list_dir', args: { path: '.' } },
  read,
  read,
  {
    name: 'replace_in_file',
    args: { path: 'a.txt', old_string: 'conteúdo da linha 10', new_string: 'mudou' },
  },
  read,
  { name: 'search', args: { query: 'linha 5' } },
  failing,
  { name: 'read_output', args: { id: 'out1', query: 'linha 250' } },
  failing,
  failing,
  { name: 'run_command', args: { command: 'node grande.js' } },
  read,
];

function scriptedChat(requests: ChatRequest[]): ChatClient {
  return {
    async chat(request: ChatRequest): Promise<ChatResponse> {
      requests.push(structuredClone(request));
      const next = scenario[requests.length - 1];
      return {
        message: {
          role: 'assistant',
          content: next ? '' : 'Pronto.',
          tool_calls: [
            next
              ? {
                  id: `c${requests.length}`,
                  type: 'function',
                  function: { name: next.name, arguments: JSON.stringify(next.args) },
                }
              : {
                  id: 'fim',
                  type: 'function',
                  function: { name: 'finish', arguments: '{"summary":"ok","success":true}' },
                },
          ],
        },
        reasoning: null,
        finishReason: 'tool_calls',
        usage: { promptTokens: 100, completionTokens: 10 },
        latencyMs: 1,
      };
    },
  } as ChatClient;
}

/** Everything the model received, with what depends on the machine taken out. */
async function recordedRequests(mode?: ContextMode) {
  const worktree = await mkdtemp(path.join(os.tmpdir(), 'hive-golden-'));
  const lines = Array.from({ length: 60 }, (_, index) => `conteúdo da linha ${index + 1}`);
  await writeFile(path.join(worktree, 'a.txt'), lines.join('\n'));
  await writeFile(
    path.join(worktree, 'falha.js'),
    "for (let i = 1; i <= 400; i++) console.log('linha ' + i);\nconsole.log('Error: quebrou');\nprocess.exit(1);\n",
  );
  // Past the 24k cap: legacy condenses it below the cap; 'off' is cut by the cap instead.
  await writeFile(
    path.join(worktree, 'grande.js'),
    "for (let i = 1; i <= 3000; i++) console.log('registro ' + i + ' ' + 'x'.repeat(40));\n",
  );
  const requests: ChatRequest[] = [];
  const runtime = new NativeAgentRuntime(mode ? { contextMode: mode } : {});
  const session = await runtime.start({
    sessionId: `golden-${mode ?? 'default'}`,
    task: { title: 'Tarefa', description: 'Faça.', acceptanceCriteria: ['Feito'], upstream: [] },
    worker: {
      id: 'w1',
      name: 'Dev',
      role: 'backend',
      systemPrompt: 'Você programa.',
      tools: ['list_dir', 'read_file', 'search', 'replace_in_file', 'run_command'],
      squad: [],
      autoApproveCommands: [],
    } as unknown as Worker,
    model: 'modelo-teste',
    chat: scriptedChat(requests),
    worktreePath: worktree,
    skills: [],
    limits,
    requestApproval: async () => true,
  });
  const outcome = await session.done;
  expect(outcome.status).toBe('completed');
  expect(requests).toHaveLength(scenario.length + 1);

  let text = JSON.stringify(requests, null, 2).replace(/\\r\\n/g, '\\n');
  for (const root of new Set([worktree, await realpath(worktree)])) {
    const escaped = JSON.stringify(root).slice(1, -1);
    text = text.split(escaped).join('<root>');
  }
  return {
    text: text.replace(/cmd\.exe \(Windows\)|\/bin\/sh/g, '<shell>'),
    requests,
    metrics: outcome.metrics!,
  };
}

const REFERENCE = './__fixtures__/legacy-requests.json';

describe("Context Shield: o modo 'legacy'", () => {
  it('é o padrão e envia ao modelo exatamente o que o Hive 0.2.3 enviava', async () => {
    const { text, metrics } = await recordedRequests();
    await expect(text).toMatchFileSnapshot(REFERENCE);
    expect(metrics.mode).toBe('legacy');
  });

  it('pedido explicitamente, envia o mesmo', async () => {
    const { text, metrics } = await recordedRequests('legacy');
    await expect(text).toMatchFileSnapshot(REFERENCE);
    expect(metrics.mode).toBe('legacy');
  });
});

describe("Context Shield: o modo 'off'", () => {
  it('envia as saídas como foram produzidas, só com o teto de tamanho e o aviso de laço', async () => {
    const { text, requests, metrics } = await recordedRequests('off');
    // Nothing of the token saver: no re-read shortcuts, no condensing, no later shortening.
    expect(text).not.toContain('since you last read it');
    expect(text).not.toContain('[Condensed:');
    expect(text).not.toContain('older output shortened');
    // read_output is not offered, and a call to it is refused like any unknown tool.
    for (const request of requests)
      expect(request.tools?.map((tool) => tool.function.name)).not.toContain('read_output');
    expect(text).toContain('Error: tool \\"read_output\\" is not available to you.');
    // The failing command reaches the model whole, every line of it.
    const failures = requests
      .at(-1)!
      .messages.filter(
        (message) =>
          message.role === 'tool' && String(message.content).startsWith('$ node falha.js'),
      );
    expect(failures).toHaveLength(3);
    const firstFailure = String(failures[0]!.content);
    for (let line = 1; line <= 400; line++) expect(firstFailure).toContain(`linha ${line}\n`);
    expect(firstFailure).toContain('Error: quebrou');
    // Safety, not saving: the hard cap and the loop warning stay.
    expect(text).toContain('characters omitted');
    expect(text).toContain('failed 3 times in a row');
    expect(metrics).toMatchObject({
      mode: 'off',
      compaction: { outputs: 0, charsRemoved: 0 },
      recoveries: 0,
    });
    // And it sends more than legacy on the same scenario, which is what a comparison measures.
    const legacy = await recordedRequests('legacy');
    expect(text.length).toBeGreaterThan(legacy.text.length);
  });
});

describe("Context Shield: o modo 'shield'", () => {
  it('é recusado enquanto não existe, para nenhuma rodada levar o nome sem a compressão', () => {
    expect(() => new NativeAgentRuntime({ contextMode: 'shield' })).toThrow(
      /ainda não foi implementado/,
    );
  });
});
