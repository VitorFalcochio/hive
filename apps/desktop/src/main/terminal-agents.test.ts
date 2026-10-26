import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentOutcome, AgentRuntime, AgentTaskInput, RuntimeEvent } from '@hive/agents';
import { defaultSettings, type Worker, type Workspace } from '@hive/core';
import { HiveDatabase, Repositories } from '@hive/persistence';
import type { ChatClient } from '@hive/providers';
import { TerminalAgents, turnDescription } from './terminal-agents';

const databases: HiveDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const workspace = { id: 'ws', name: 'app', path: '/projetos/app' } as Workspace;

/** A runtime that reports one state change and finishes with a fixed outcome. */
function fakeRuntime(seen: AgentTaskInput[]): AgentRuntime {
  const listeners = new Map<string, (event: RuntimeEvent) => void>();
  return {
    id: 'fake',
    async start(input) {
      seen.push(input);
      const done = new Promise<AgentOutcome>((resolve) =>
        setTimeout(() => {
          listeners.get(input.sessionId)?.({
            type: 'worker.state',
            level: 'info',
            message: 'esperando',
            data: { state: 'waiting_provider' },
          });
          resolve({
            status: 'completed',
            summary: 'Pronto.',
            error: null,
            steps: 2,
            usage: { promptTokens: 700, completionTokens: 70 },
            commands: [],
          });
        }, 10),
      );
      return { id: input.sessionId, done };
    },
    async cancel() {},
    subscribe(sessionId, onEvent) {
      listeners.set(sessionId, onEvent);
      return () => listeners.delete(sessionId);
    },
  };
}

describe('conversas no terminal', () => {
  it('lembra o pedido no idioma do usuário e as trocas anteriores', () => {
    expect(turnDescription('liste os arquivos', [])).toContain(
      '(Reply in the language of this message.)',
    );
    expect(turnDescription('e agora?', [{ request: 'oi', reply: 'olá' }])).toContain(
      'User: oi\nYou: olá',
    );
  });

  it('mostra a abelha trabalhando enquanto responde e conta os tokens no dia', async () => {
    const db = new HiveDatabase(':memory:');
    databases.push(db);
    const repos = new Repositories(db);
    const worker = {
      id: 'w1',
      name: 'Frontend',
      role: 'frontend',
      beeColor: null,
      squad: [],
      description: '',
      providerId: 'p',
      modelId: 'm',
      skills: [],
      tools: ['read_file'],
      autoApproveCommands: [],
      mcpServers: [],
      systemPrompt: '',
      limits: defaultSettings.defaultLimits,
      createdAt: '',
      updatedAt: '',
    } satisfies Worker;
    repos.workers.put(worker);
    const seen: AgentTaskInput[] = [];
    const onChange = vi.fn();
    const agents = new TerminalAgents({
      repos,
      chatFor: () => ({}) as ChatClient,
      resolveSkills: async () => [],
      onWorkerChanged: () => undefined,
      onChange,
      runtime: fakeRuntime(seen),
    });

    const pending = agents.turn(
      workspace,
      'w1',
      'arrume o botão',
      [],
      { onEvent: () => undefined, approve: async () => 'no' },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(agents.activeChats()).toHaveLength(1));
    expect(agents.activeChats()[0]).toMatchObject({ workerId: 'w1', title: 'arrume o botão' });

    const outcome = await pending;
    expect(outcome.summary).toBe('Pronto.');
    expect(seen[0]).toMatchObject({ place: 'project', worktreePath: '/projetos/app' });
    expect(agents.activeChats()).toEqual([]);
    expect(repos.usageSince('2000-01-01T00:00:00.000Z')).toEqual({
      promptTokens: 700,
      completionTokens: 70,
    });
    // Started, began waiting for the provider, finished.
    expect(onChange).toHaveBeenCalledTimes(3);
  });
});
