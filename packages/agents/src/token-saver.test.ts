import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecutionLimits, Worker } from '@hive/core';
import type { ChatClient, ChatRequest, ChatResponse } from '@hive/providers';
import { NativeAgentRuntime } from './native-runtime';
import type { RuntimeEvent } from './runtime';
import { TokenSaver, condenseOutput, readOutput, rereadOutput } from './token-saver';

const lines = (count: number, label = 'linha') =>
  Array.from({ length: count }, (_, index) => `${label} ${index + 1}`);
const header = { path: 'a.txt', start: 1, end: 40, total: 40 };

describe('rereadOutput', () => {
  it('answers an unchanged window in one line', () => {
    expect(rereadOutput(header, lines(40), lines(40))).toBe(
      'a.txt (lines 1-40 of 40) is unchanged since you last read it: use that earlier output.',
    );
  });

  it('shows only the changed lines, with their numbers', () => {
    const after = lines(40);
    after[9] = 'linha nova';
    const output = rereadOutput(header, lines(40), after)!;
    expect(output).toContain('Lines 10-10 of your earlier read were replaced by:');
    expect(output).toContain('   10  linha nova');
    expect(output).not.toContain('linha 30');
  });

  it('says how the following lines moved after an insertion or deletion', () => {
    const inserted = [...lines(20), 'extra 1', 'extra 2', ...lines(40).slice(20)];
    const grown = rereadOutput({ ...header, end: 42, total: 42 }, lines(40), inserted)!;
    expect(grown).toContain('New lines inserted at line 21:');
    expect(grown).toContain('moved down by 2');
    const shrunk = rereadOutput(
      header,
      lines(40),
      lines(40).filter((_, index) => index !== 4),
    )!;
    expect(shrunk).toContain('Lines 5-5 of your earlier read were replaced by nothing (deleted).');
    expect(shrunk).toContain('moved up by 1');
  });

  it('sends the window in full when most of it changed, or when it is short', () => {
    expect(rereadOutput(header, lines(40), lines(40, 'outra'))).toBeNull();
    expect(rereadOutput({ ...header, end: 5, total: 5 }, lines(5), lines(4))).toBeNull();
  });
});

describe('condenseOutput', () => {
  it('keeps the start, the errors with context and the end, numbered, and points to the rest', () => {
    const output = [...lines(300), 'Error: quebrou aqui', 'at app.js:10', ...lines(300, 'fim')];
    const condensed = condenseOutput(output, 'out1');
    expect(condensed).toContain('    1  linha 1');
    expect(condensed).toContain('  301  Error: quebrou aqui');
    expect(condensed).toContain('  302  at app.js:10');
    expect(condensed).toContain('  602  fim 300');
    expect(condensed).not.toContain('linha 150');
    expect(condensed).toContain('[… 294 lines …]');
    expect(condensed).toContain('read_output with id "out1"');
    expect(condensed.length).toBeLessThan(output.join('\n').length / 3);
  });
});

describe('TokenSaver', () => {
  it('reads kept outputs by range and by query', () => {
    const saver = new TokenSaver();
    const id = saver.storeOutput(lines(500));
    expect(id).toBe('out1');
    expect(readOutput(saver, { id, start_line: 250, end_line: 251 })).toBe(
      'out1 (lines 250-251 of 500; pass start_line=252 to read on)\n  250  linha 250\n  251  linha 251',
    );
    expect(readOutput(saver, { id, query: 'LINHA 49' })).toContain('11 lines contain');
    expect(() => readOutput(saver, { id: 'out9' })).toThrow('No kept output');
  });

  it('counts failures in a row with the same error, whatever the numbers in it', () => {
    const saver = new TokenSaver();
    expect(saver.commandResult('npm test', true, 'FAIL em 1.2s')).toBe(1);
    expect(saver.commandResult('npm test', true, 'FAIL em 3.4s')).toBe(2);
    expect(saver.commandResult('npm test', true, 'outro erro')).toBe(1);
    expect(saver.commandResult('npm test', false, '')).toBe(0);
    expect(saver.commandResult('npm test', true, 'outro erro')).toBe(1);
  });

  it('forgets a read once a message it relies on was shortened', () => {
    const saver = new TokenSaver();
    saver.remember('a.txt:1:window', lines(3), 'c1', false);
    saver.remember('a.txt:1:window', lines(3), 'c2', true);
    saver.forgetCall('c1');
    expect(saver.lastRead('a.txt:1:window')).toBeUndefined();
  });
});

const limits: ExecutionLimits = {
  maxSteps: 20,
  maxTokens: 1_000_000,
  commandTimeoutSec: 20,
  taskTimeoutMin: 1,
  temperature: null,
};

/** A model that makes the given calls, one per step, then finishes. */
function scriptedChat(
  calls: { name: string; args: Record<string, unknown>; before?: () => Promise<void> }[],
  requests: ChatRequest[],
): ChatClient {
  return {
    async chat(request: ChatRequest): Promise<ChatResponse> {
      requests.push(structuredClone(request));
      const next = calls[requests.length - 1];
      await next?.before?.();
      return {
        message: {
          role: 'assistant',
          content: '',
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
        usage: null,
        latencyMs: 1,
      };
    },
  } as ChatClient;
}

async function run(
  id: string,
  worktree: string,
  tools: string[],
  calls: Parameters<typeof scriptedChat>[0],
) {
  const requests: ChatRequest[] = [];
  const events: RuntimeEvent[] = [];
  const runtime = new NativeAgentRuntime();
  const session = await runtime.start({
    sessionId: id,
    task: { title: 'Tarefa', description: 'Faça.', acceptanceCriteria: [], upstream: [] },
    worker: {
      id: 'w1',
      name: 'Dev',
      role: 'code',
      systemPrompt: 'Você programa.',
      tools,
      autoApproveCommands: [],
    } as unknown as Worker,
    model: 'test-model',
    chat: scriptedChat(calls, requests),
    worktreePath: worktree,
    skills: [],
    limits,
    requestApproval: async () => true,
  });
  runtime.subscribe(id, (event) => events.push(event));
  expect((await session.done).status).toBe('completed');
  /** The output each call got, as the model saw it on the next step. */
  const outputs = requests.slice(1).map((request) => String(request.messages.at(-1)!.content));
  const final = requests.at(-1)!.messages.filter((message) => message.role === 'tool');
  return { events, outputs, final: final.map((message) => String(message.content)) };
}

describe('NativeAgentRuntime token saver', () => {
  it('answers re-reads with "unchanged" or the diff, and in full once the first read was shortened', async () => {
    const worktree = await mkdtemp(path.join(os.tmpdir(), 'hive-reread-'));
    const file = path.join(worktree, 'a.txt');
    const original = lines(60, 'conteúdo da linha');
    await writeFile(file, original.join('\n'));
    await writeFile(path.join(worktree, 'b.txt'), 'b');
    const read = { name: 'read_file', args: { path: 'a.txt' } };
    const { outputs, final } = await run(
      'reread',
      worktree,
      ['read_file'],
      [
        read,
        read,
        {
          ...read,
          before: () =>
            writeFile(file, original.map((line, i) => (i === 9 ? 'mudou' : line)).join('\n')),
        },
        { name: 'read_file', args: { path: 'b.txt' } },
        read,
      ],
    );
    expect(outputs[0]).toContain('conteúdo da linha 60');
    expect(outputs[1]).toBe(
      'a.txt (lines 1-60 of 60) is unchanged since you last read it: use that earlier output.',
    );
    expect(outputs[2]).toContain('   10  mudou');
    expect(outputs[2]).not.toContain('conteúdo da linha 30');
    // By then the first read was shortened, so the window comes back whole.
    expect(final[0]).toContain('older output shortened');
    expect(outputs[4]).toContain('   10  mudou');
    expect(outputs[4]).toContain('conteúdo da linha 60');
  });

  it('condenses a long command output, keeps the rest for read_output and calls out a loop', async () => {
    const worktree = await mkdtemp(path.join(os.tmpdir(), 'hive-output-'));
    await writeFile(
      path.join(worktree, 'falha.js'),
      "for (let i = 1; i <= 400; i++) console.log('linha ' + i);\nconsole.log('Error: quebrou');\nprocess.exit(1);\n",
    );
    const command = { name: 'run_command', args: { command: 'node falha.js' } };
    const { outputs, events } = await run(
      'output',
      worktree,
      ['run_command'],
      [
        command,
        { name: 'read_output', args: { id: 'out1', query: 'linha 250' } },
        command,
        command,
      ],
    );
    expect(outputs[0]).toContain('Error: quebrou');
    expect(outputs[0]).toContain('[Condensed:');
    expect(outputs[0]).not.toContain('linha 200\n');
    expect(outputs[1]).toContain('  250  linha 250');
    expect(outputs[2]).not.toContain('failed 3 times');
    expect(outputs[3]).toContain('failed 3 times in a row');
    expect(events.map((event) => event.message)).toContain(
      '"node falha.js" falhou 3 vezes seguidas com o mesmo erro; o agente foi avisado para mudar de abordagem.',
    );
    expect(events.map((event) => event.message)).toContain('Leu mais da saída out1');
  });
});
