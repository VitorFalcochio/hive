import { describe, expect, it, vi } from 'vitest';
import type { AgentOutcome } from '@hive/agents';
import type { Worker, Workspace } from '@hive/core';
import { cleanTerminalOutput } from './terminal';
import type { Exchange, TurnHandlers } from './terminal-agents';
import { describeTool, HiveTerminalApp, splitKeys } from './terminal-ui';

const workspace = { id: 'ws', name: 'crew.os', path: 'C:\\projetos\\crew.os' } as Workspace;
const worker = (id: string, name: string, role: Worker['role'], modelId: string | null) =>
  ({ id, name, role, beeColor: null, providerId: modelId && 'p', modelId }) as Worker;
const workers = [
  worker('q', 'Queen · Coordinator', 'queen', 'nemotron'),
  worker('f', 'Frontend Developer', 'frontend', 'minimax'),
  worker('x', 'Sem Modelo', 'custom', null),
];
const outcome = (summary: string): AgentOutcome => ({
  status: 'completed',
  summary,
  error: null,
  steps: 3,
  usage: { promptTokens: 1_000, completionTokens: 200 },
  commands: [],
});

function setup(turn = vi.fn()) {
  let screen = '';
  const end = vi.fn();
  const app = new HiveTerminalApp(
    { write: (text) => (screen += text), size: () => ({ cols: 100, rows: 30 }), end },
    { workspace, workers: () => workers, turn, cost: () => 'grátis' },
  );
  return { app, end, turn, screen: () => cleanTerminalOutput(screen) };
}

describe('terminal do Hive', () => {
  it('separa teclas e descreve as ferramentas em português', () => {
    expect(splitKeys('a\x1b[Bç\r')).toEqual(['a', '\x1b[B', 'ç', '\r']);
    expect(describeTool('run_command', { command: 'npm test' })).toBe('$ npm test');
    expect(describeTool('replace_in_file', { path: 'src/app.ts' })).toBe('Editando src/app.ts');
  });

  it('lista as abelhas, escolhe com as setas e conversa com a escolhida', async () => {
    const turn = vi.fn(
      async (
        _worker: string,
        _request: string,
        _history: Exchange[],
        handlers: TurnHandlers,
      ): Promise<AgentOutcome> => {
        handlers.onEvent({
          type: 'tool.call',
          level: 'info',
          message: 'read_file',
          data: { tool: 'read_file', args: { path: 'README.md' } },
        });
        return outcome('O projeto é um app de tarefas.');
      },
    );
    const { app, screen } = setup(turn);
    app.start('agents');
    expect(screen()).toContain('Queen · Coordinator');
    expect(screen()).toContain('sem modelo');

    app.input('\x1b[B');
    app.input('\r');
    expect(screen()).toContain('Trabalhando direto em C:\\projetos\\crew.os');

    app.input('o que é este projeto?');
    app.input('\r');
    await vi.waitFor(() => expect(screen()).toContain('O projeto é um app de tarefas.'));
    expect(turn.mock.calls[0]![0]).toBe('f');
    expect(turn.mock.calls[0]![1]).toBe('o que é este projeto?');
    expect(screen()).toContain('⎿ Lendo README.md');
    expect(screen()).toContain('3 passo(s) · 1.200 tokens');

    // The next request carries the conversation so far.
    app.input('e os testes?\r');
    await vi.waitFor(() => expect(turn).toHaveBeenCalledTimes(2));
    expect(turn.mock.calls[1]![2]).toEqual([
      { request: 'o que é este projeto?', reply: 'O projeto é um app de tarefas.' },
    ]);
  });

  it('não deixa escolher quem não tem modelo e sai com Esc', () => {
    const { app, end, screen } = setup();
    app.start('agents');
    app.input('\x1b[A'); // wraps to the last agent
    app.input('\r');
    expect(screen()).toContain('Sem Modelo ainda não tem modelo');
    app.input('\x1b');
    expect(end).toHaveBeenCalled();
  });

  it('pergunta antes de rodar comandos e aceita "sempre"', async () => {
    let answer: Promise<string> | null = null;
    const turn = vi.fn(async (...args: Parameters<TerminalAppServicesTurn>) => {
      answer = args[3].approve('npm test');
      return outcome(`resposta: ${await answer}`);
    });
    const { app, screen } = setup(turn);
    app.start('agents');
    app.input('\x1b[B\r');
    app.input('rode os testes\r');
    await vi.waitFor(() => expect(screen()).toContain('quer rodar npm test'));
    app.input('a');
    await vi.waitFor(() => expect(screen()).toContain('resposta: always'));
  });

  it('mostra a ajuda e devolve o terminal com o comando hive', () => {
    const { app, end, screen } = setup();
    app.start('help');
    expect(screen()).toContain('escolher uma abelha');
    expect(end).toHaveBeenCalled();
  });
});

type TerminalAppServicesTurn = (
  worker: string,
  request: string,
  history: Exchange[],
  handlers: TurnHandlers,
  signal: AbortSignal,
) => Promise<AgentOutcome>;
