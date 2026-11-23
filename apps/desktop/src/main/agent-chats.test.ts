import os from 'node:os';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentOutcome, AgentRuntime, AgentTaskInput, RuntimeEvent } from '@hive/agents';
import { defaultSettings, type HivePush, type Worker } from '@hive/core';
import { HiveDatabase, Repositories } from '@hive/persistence';
import type { ChatClient } from '@hive/providers';
import { AgentChats, changedBetween, exchangesOf } from './agent-chats';

const databases: HiveDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const worker = {
  id: 'w1',
  name: 'Backend Developer',
  role: 'backend',
  beeColor: null,
  squad: [],
  description: '',
  providerId: 'p',
  modelId: 'm',
  skills: [],
  tools: ['read_file', 'search', 'write_file', 'replace_in_file', 'run_command'],
  autoApproveCommands: [],
  mcpServers: [],
  systemPrompt: 'Você cuida do servidor.',
  limits: defaultSettings.defaultLimits,
  createdAt: '',
  updatedAt: '',
} satisfies Worker;

/**
 * A runtime driven by the test: `script` runs with the session's emit and approval, and its
 * return value is the outcome. Cancel resolves the session as cancelled, as real engines do.
 */
function scriptedRuntime(
  script: (
    input: AgentTaskInput,
    emit: (event: RuntimeEvent) => void,
    signal: AbortSignal,
  ) => Promise<Partial<AgentOutcome>>,
) {
  const seen: AgentTaskInput[] = [];
  const listeners = new Map<string, (event: RuntimeEvent) => void>();
  const controllers = new Map<string, AbortController>();
  const runtime: AgentRuntime = {
    id: 'fake',
    async start(input) {
      seen.push(input);
      const controller = new AbortController();
      controllers.set(input.sessionId, controller);
      const emit = (event: RuntimeEvent) => listeners.get(input.sessionId)?.(event);
      const base: AgentOutcome = {
        status: 'completed',
        summary: '',
        error: null,
        steps: 1,
        usage: { promptTokens: 100, completionTokens: 10 },
        commands: [],
      };
      const done = new Promise<AgentOutcome>((resolve) => {
        controller.signal.addEventListener('abort', () =>
          resolve({ ...base, status: 'cancelled', error: 'Cancelled by user.' }),
        );
        // Lets the caller subscribe before anything is emitted.
        setTimeout(() => {
          script(input, emit, controller.signal).then(
            (outcome) => resolve({ ...base, ...outcome }),
            (error: unknown) =>
              resolve({ ...base, status: 'failed', error: String((error as Error).message) }),
          );
        }, 5);
      });
      return { id: input.sessionId, done };
    },
    async cancel(sessionId) {
      controllers.get(sessionId)?.abort();
    },
    subscribe(sessionId, onEvent) {
      listeners.set(sessionId, onEvent);
      return () => listeners.delete(sessionId);
    },
  };
  return { runtime, seen };
}

function setup(runtime: AgentRuntime, extra: { gitStatus?: () => Promise<never[]> } = {}) {
  const db = new HiveDatabase(':memory:');
  databases.push(db);
  const repos = new Repositories(db);
  // Workspace paths are unique in the database; each test setup needs its own
  // temporary project path because several workspaces are created below.
  const folder = path.join(os.tmpdir(), `hive-agent-chat-${Math.random().toString(36).slice(2)}`);
  for (const id of ['slash', 'hive'])
    mkdirSync(path.join(folder, id), { recursive: true });
  for (const id of ['slash', 'hive'])
    repos.workspaces.put({
      id,
      name: id,
      path: path.join(folder, id),
      defaultBranch: 'main',
      createdAt: '',
      lastOpenedAt: '',
    });
  repos.providers.put({
    id: 'p',
    kind: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'http://localhost:11434/v1',
    enabled: true,
    hasCredential: false,
    credentialHint: null,
    lastTest: null,
    modelsFetchedAt: null,
    createdAt: '',
  });
  repos.workers.put(worker);
  const pushes: Extract<HivePush, { kind: 'agentChat' }>[] = [];
  const chats = new AgentChats({
    repos,
    runtime,
    runtimeFor: () => null,
    chatForWorker: () => ({}) as ChatClient,
    resolveSkills: async () => [],
    push: (push) => {
      if (push.kind === 'agentChat') pushes.push(push);
    },
    onWorkerChanged: () => undefined,
    onChange: vi.fn(),
    ...extra,
  });
  return { repos, chats, pushes };
}

/** Waits until the conversation's agent stops working. */
async function settled(chats: AgentChats, chatId: string) {
  await vi.waitFor(() => expect(chats.state(chatId).running).toBe(false), { timeout: 2_000 });
}

describe('Direct Agent Chat', () => {
  it('conversa: roda o agente real sem missão, só com ferramentas de leitura, e guarda a resposta', async () => {
    const { runtime, seen } = scriptedRuntime(async (_input, emit) => {
      emit({
        type: 'tool.call',
        level: 'info',
        message: 'read_file',
        data: { tool: 'read_file', args: { path: 'src/auth.ts' } },
      });
      emit({
        type: 'tool.result',
        level: 'debug',
        message: 'ok',
        data: { tool: 'read_file', isError: false, output: 'export function login() {}' },
      });
      return { summary: 'A autenticação fica em **src/auth.ts**.' };
    });
    const { repos, chats, pushes } = setup(runtime);
    const chat = chats.create('slash', 'w1');
    const { user, agent } = await chats.send(chat.id, 'Explique a autenticação', 'conversation');
    expect(agent.status).toBe('running');
    expect(agent.model).toMatchObject({ providerName: 'OpenRouter', modelId: 'm', runtime: 'fake' });
    await settled(chats, chat.id);

    const input = seen[0]!;
    expect(input.readOnly).toBe(true);
    expect(input.place).toBe('project');
    expect(input.worker.systemPrompt).toBe('Você cuida do servidor.');
    expect(input.task.description).toContain('Mode: conversation');
    expect(input.task.description).toContain('Explique a autenticação');

    const page = chats.messages(chat.id);
    expect(page.messages.map((item) => item.id)).toEqual([user.id, agent.id]);
    const reply = page.messages[1]!;
    expect(reply.status).toBe('completed');
    expect(reply.content).toContain('src/auth.ts');
    expect(reply.steps[0]).toMatchObject({ kind: 'tool', label: 'Lendo src/auth.ts', status: 'ok' });
    expect(pushes.at(-1)?.message.status).toBe('completed');
    // The first request names the conversation, and its tokens count in the daily meter.
    expect(repos.agentChats.require(chat.id, 'Conversa').title).toBe('Explique a autenticação');
    expect(repos.chatTurns.get(agent.id)?.promptTokens).toBe(100);
  });

  it('conversa: nega qualquer comando sem perguntar', async () => {
    let allowed: boolean | null = null;
    const { runtime } = scriptedRuntime(async (input) => {
      allowed = await input.requestApproval({ command: 'rm -rf build' });
      return { summary: 'ok' };
    });
    const { chats } = setup(runtime);
    const chat = chats.create('slash', 'w1');
    await chats.send(chat.id, 'apague o build', 'conversation');
    await settled(chats, chat.id);
    expect(allowed).toBe(false);
    expect(chats.messages(chat.id).messages[1]!.steps[0]!.label).toContain('modo Conversa');
  });

  it('execução: pede aprovação no chat, registra "sempre permitir" e lista os arquivos alterados', async () => {
    const { runtime, seen } = scriptedRuntime(async (input, emit) => {
      emit({
        type: 'tool.call',
        level: 'info',
        message: 'write_file',
        data: { tool: 'write_file', args: { path: 'src/settings.tsx' } },
      });
      const ok = await input.requestApproval({ command: 'npm test' });
      return { summary: ok ? 'Criei a página e os testes passaram.' : 'Negado.' };
    });
    const { repos, chats } = setup(runtime);
    repos.saveSettings({ ...repos.getSettings(), commandApproval: 'ask' });
    const chat = chats.create('slash', 'w1');
    await chats.send(chat.id, 'Crie a página de configurações', 'execution');
    await vi.waitFor(() => expect(chats.state(chat.id).approval).not.toBeNull());
    const { approval } = chats.state(chat.id);
    expect(approval?.command).toBe('npm test');
    chats.approve(chat.id, approval!.id, 'always');
    await settled(chats, chat.id);

    expect(seen[0]!.readOnly).toBe(false);
    const reply = chats.messages(chat.id).messages[1]!;
    expect(reply.content).toBe('Criei a página e os testes passaram.');
    expect(reply.changedFiles).toEqual(['src/settings.tsx']);
    expect(reply.steps.some((step) => step.label === 'Aprovado: npm test')).toBe(true);
    expect(repos.workers.require('w1', 'Agente').autoApproveCommands).toContain('npm test');
  });

  it('interromper: cancela a execução, nega a aprovação pendente e nunca mostra como concluída', async () => {
    const { runtime } = scriptedRuntime(async (input) => {
      await input.requestApproval({ command: 'npm run build' });
      return { summary: 'não deveria chegar aqui' };
    });
    const { repos, chats } = setup(runtime);
    repos.saveSettings({ ...repos.getSettings(), commandApproval: 'ask' });
    const chat = chats.create('slash', 'w1');
    await chats.send(chat.id, 'Faça o build', 'execution');
    await vi.waitFor(() => expect(chats.state(chat.id).approval).not.toBeNull());
    chats.cancel(chat.id);
    await settled(chats, chat.id);
    const reply = chats.messages(chat.id).messages[1]!;
    expect(reply.status).toBe('cancelled');
    expect(reply.content).toBe('');
    expect(reply.steps.every((step) => step.status !== 'running')).toBe(true);
  });

  it('uma execução por projeto; outro projeto e conversas continuam livres', async () => {
    const releases: (() => void)[] = [];
    const { runtime } = scriptedRuntime(
      () => new Promise((resolve) => releases.push(() => resolve({ summary: 'fim' }))),
    );
    const { repos, chats } = setup(runtime);
    repos.workers.put({ ...worker, id: 'w2', name: 'Frontend Developer', role: 'frontend' });
    const first = chats.create('slash', 'w1');
    await chats.send(first.id, 'refatore a autenticação', 'execution');
    const second = chats.create('slash', 'w2');
    await expect(chats.send(second.id, 'crie a tela', 'execution')).rejects.toThrow(
      /Backend Developer já está executando/,
    );
    await expect(chats.send(first.id, 'e agora?', 'conversation')).rejects.toThrow(
      /ainda está respondendo/,
    );
    const other = chats.create('hive', 'w2');
    await chats.send(other.id, 'crie a tela', 'execution');
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.forEach((release) => release());
    await settled(chats, first.id);
    await settled(chats, other.id);
  });

  it('isolamento: as conversas de um projeto não aparecem no outro', () => {
    const { runtime } = scriptedRuntime(async () => ({ summary: 'ok' }));
    const { chats } = setup(runtime);
    const slash = chats.create('slash', 'w1');
    const hive = chats.create('hive', 'w1');
    expect(chats.list('slash', 'w1').map((chat) => chat.id)).toEqual([slash.id]);
    expect(chats.list('hive', 'w1').map((chat) => chat.id)).toEqual([hive.id]);
  });

  it('lembra as trocas anteriores da mesma conversa', async () => {
    const { runtime, seen } = scriptedRuntime(async () => ({ summary: 'Use JWT.' }));
    const { chats } = setup(runtime);
    const chat = chats.create('slash', 'w1');
    await chats.send(chat.id, 'Como autenticar?', 'conversation');
    await settled(chats, chat.id);
    await chats.send(chat.id, 'E a expiração?', 'conversation');
    await settled(chats, chat.id);
    expect(seen[1]!.task.description).toContain('User: Como autenticar?\nYou: Use JWT.');
  });

  it('erros claros: agente sem modelo, provedor desligado, projeto removido e falha do provedor', async () => {
    const { runtime } = scriptedRuntime(async () => {
      throw new Error('HTTP 503: modelo indisponível');
    });
    const { repos, chats } = setup(runtime);
    const chat = chats.create('slash', 'w1');

    repos.workers.put({ ...worker, modelId: null });
    await expect(chats.send(chat.id, 'oi', 'conversation')).rejects.toThrow(/provedor e um modelo/);
    repos.workers.put(worker);

    const provider = repos.providers.require('p', 'Provedor');
    repos.providers.put({ ...provider, enabled: false });
    await expect(chats.send(chat.id, 'oi', 'conversation')).rejects.toThrow(/está desligado/);
    repos.providers.put(provider);

    await chats.send(chat.id, 'oi', 'conversation');
    await settled(chats, chat.id);
    const reply = chats.messages(chat.id).messages[1]!;
    expect(reply.status).toBe('failed');
    expect(reply.error).toContain('modelo indisponível');

    repos.workspaces.delete('slash');
    await expect(chats.send(chat.id, 'oi', 'conversation')).rejects.toThrow(/foi removido/);
  });

  it('respostas que estavam rodando quando o Hive fechou voltam como interrompidas', async () => {
    const { runtime } = scriptedRuntime(() => new Promise(() => undefined));
    const { repos, chats } = setup(runtime);
    const chat = chats.create('slash', 'w1');
    const { agent } = await chats.send(chat.id, 'demore', 'execution');
    // A new service over the same database is what the next start of Hive does.
    const reopened = new AgentChats({
      repos,
      runtime,
      runtimeFor: () => null,
      chatForWorker: () => ({}) as ChatClient,
      resolveSkills: async () => [],
      push: () => undefined,
      onWorkerChanged: () => undefined,
      onChange: () => undefined,
    });
    const reply = reopened.messages(chat.id).messages.find((item) => item.id === agent.id)!;
    expect(reply.status).toBe('interrupted');
    expect(reply.error).toMatch(/fechado/);
    chats.cancel(chat.id);
  });

  it('pagina o histórico do mais antigo ao mais novo', async () => {
    const { runtime } = scriptedRuntime(async () => ({ summary: 'ok' }));
    const { chats } = setup(runtime);
    const chat = chats.create('slash', 'w1');
    for (const text of ['um', 'dois', 'três']) {
      await chats.send(chat.id, text, 'conversation');
      await settled(chats, chat.id);
    }
    const latest = chats.messages(chat.id, 2);
    expect(latest.more).toBe(true);
    expect(latest.messages.map((item) => item.content)).toEqual(['três', 'ok']);
    const older = chats.messages(chat.id, 10, latest.messages[0]!.id);
    expect(older.more).toBe(false);
    expect(older.messages.map((item) => item.content)).toEqual(['um', 'ok', 'dois', 'ok']);
  });
});

describe('ajudantes do chat direto', () => {
  it('compara o git status antes e depois', () => {
    expect(
      changedBetween(
        [
          { path: 'a.ts', status: ' M' },
          { path: 'b.ts', status: '??' },
        ],
        [
          { path: 'a.ts', status: ' M' },
          { path: 'c.ts', status: '??' },
        ],
      ).sort(),
    ).toEqual(['b.ts', 'c.ts']);
  });

  it('monta as trocas só com respostas terminadas', () => {
    const base = {
      chatId: 'c',
      mode: 'conversation' as const,
      error: null,
      model: null,
      steps: [],
      droppedSteps: 0,
      changedFiles: [],
      usage: { promptTokens: 0, completionTokens: 0 },
      createdAt: '',
      finishedAt: null,
    };
    expect(
      exchangesOf([
        { ...base, id: '1', role: 'user', content: 'oi', status: 'completed' },
        { ...base, id: '2', role: 'agent', content: 'olá', status: 'completed' },
        { ...base, id: '3', role: 'user', content: 'e aí?', status: 'completed' },
        { ...base, id: '4', role: 'agent', content: '', status: 'running' },
      ]),
    ).toEqual([{ request: 'oi', reply: 'olá' }]);
  });
});
