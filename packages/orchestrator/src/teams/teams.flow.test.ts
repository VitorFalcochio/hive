import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeAgentRuntime } from '@hive/agents';
import {
  defaultLimits,
  defaultSettings,
  type ModelInfo,
  type ProviderConfig,
  type Task,
  type ToolName,
  type Worker,
} from '@hive/core';
import { HiveDatabase, Repositories } from '@hive/persistence';
import {
  ProviderError,
  type ChatClient,
  type ChatRequest,
  type ChatResponse,
} from '@hive/providers';
import { Scheduler } from '../scheduler';
import { HiveTeams } from './engine';
import { teamToolsFor } from './tools';

/*
 * The Hive Teams test scenario, end to end with everything real but the models: the Scheduler,
 * Hive's own agent runtime (NativeAgentRuntime), git worktrees, the review mechanism and a QA
 * agent that runs the project's tests. Three providers are simulated by scripted clients; each
 * agent's requests go only to its own provider.
 *
 *   Queen plan: [Claude leads the API] → [QA runs the tests]
 *   Claude writes the contract, creates Codex (ChatGPT) and Nemotron (NVIDIA), delegates the
 *   implementation and a review; Nemotron asks for a change; Codex fixes it; Claude is resumed,
 *   reports to the Queen; QA runs node --test; the mission waits for approval.
 */

const databases: HiveDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const at = '2026-01-01T00:00:00.000Z';
const tools: ToolName[] = [
  'list_dir',
  'read_file',
  'search',
  'write_file',
  'replace_in_file',
  'run_command',
];

const CONTRACT = `# API de tarefas\n\ncreateTask(title) devolve { id, title, done: false }; título vazio lança Error("title is required").\n`;
const TESTS = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTask } from '../src/tasks.js';

test('cria uma tarefa aberta', () => {
  assert.deepEqual(createTask('Comprar pão'), { id: 1, title: 'Comprar pão', done: false });
});

test('recusa título vazio', () => {
  assert.throws(() => createTask(''), /title is required/);
});
`;
const BUGGY = `let next = 1;\nexport function createTask(title) {\n  return { id: next++, title, done: false };\n}\n`;
const FIXED = `let next = 1;\nexport function createTask(title) {\n  if (!title || !title.trim()) throw new Error('title is required');\n  return { id: next++, title, done: false };\n}\n`;

type Step = (
  request: ChatRequest,
) => { name: string; args: Record<string, unknown> } | { text: string };

/** Reads an id out of an earlier tool result of the same session, e.g. the agent Hive created. */
function fromResults(request: ChatRequest, pattern: RegExp, nth = 0): string {
  const found = request.messages
    .filter((message) => message.role === 'tool')
    .map((message) => pattern.exec(String(message.content))?.[1])
    .filter(Boolean);
  if (!found[nth])
    throw new Error(
      `Esperava ${pattern} nos resultados: ${JSON.stringify(request.messages.slice(-2))}`,
    );
  return found[nth]!;
}

const agentId = (nth: number) => (request: ChatRequest) =>
  fromResults(request, /agentId "([^"]+)"/, nth);

/** Which session a request belongs to, from its prompts, and the step within it. */
function session(request: ChatRequest): { system: string; task: string; step: number } {
  return {
    system: String(request.messages[0]?.content ?? ''),
    task: String(request.messages[1]?.content ?? ''),
    step: request.messages.filter((message) => message.role === 'assistant').length,
  };
}

const scripts: Record<string, (request: ChatRequest) => Step[]> = {
  // Claude: the technical lead, on OpenRouter.
  openrouter: (request) => {
    const { task } = session(request);
    if (task.includes('# Task: Consolidar a equipe'))
      return [
        () => ({
          name: 'report_to_queen',
          args: {
            summary: 'API de tarefas implementada pelo Codex, revisada pelo Nemotron e corrigida.',
          },
        }),
        () => ({
          name: 'finish',
          args: { summary: 'Equipe concluída; relatório enviado à Queen.', success: true },
        }),
      ];
    if (task.includes('# Task: Rodar os testes'))
      return [
        () => ({ name: 'run_command', args: { command: 'node --test' } }),
        () => ({ name: 'finish', args: { summary: 'node --test passou.', success: true } }),
      ];
    return [
      () => ({ name: 'write_file', args: { path: 'docs/api.md', content: CONTRACT } }),
      () => ({
        name: 'spawn_agent',
        args: { key: 'codex', name: 'Codex', role: 'backend', family: 'codex' },
      }),
      () => ({
        name: 'spawn_agent',
        args: { key: 'nemotron', name: 'Nemotron', role: 'reviewer', family: 'nemotron' },
      }),
      (r) => ({
        name: 'delegate_task',
        args: {
          key: 'implementar',
          agentId: agentId(0)(r),
          title: 'Implementar a API de tarefas',
          description: 'Implemente src/tasks.js seguindo docs/api.md; os testes estão em test/.',
          acceptanceCriteria: ['node --test passa'],
        },
      }),
      (r) => ({
        name: 'request_review',
        args: {
          key: 'revisar',
          agentId: agentId(1)(r),
          of: ['implementar'],
          instructions: 'Confira o contrato e os testes.',
        },
      }),
      () => ({
        name: 'finish',
        args: {
          summary: 'Contrato em docs/api.md; equipe montada e trabalho delegado.',
          success: true,
        },
      }),
    ];
  },
  // Codex: the implementation, on the ChatGPT sign-in.
  chatgpt: (request) => {
    const revising = session(request).task.includes('Review of your previous result');
    return [
      () => ({
        name: 'write_file',
        args: { path: 'src/tasks.js', content: revising ? FIXED : BUGGY },
      }),
      () => ({
        name: 'finish',
        args: {
          summary: revising ? 'Título vazio agora é recusado.' : 'createTask implementado.',
          success: true,
        },
      }),
    ];
  },
  // Nemotron: the review, on NVIDIA.
  nvidia: () => [
    () => ({ name: 'read_file', args: { path: 'src/tasks.js' } }),
    () => ({
      name: 'submit_review',
      args: {
        verdict: 'changes_requested',
        summary: 'O contrato exige recusar título vazio.',
        comments: [
          {
            path: 'src/tasks.js',
            line: 2,
            body: 'Lance Error("title is required") para título vazio.',
            severity: 'major',
          },
        ],
      },
    }),
    () => ({ name: 'finish', args: { summary: 'Revisão enviada.', success: true } }),
  ],
};

interface Call {
  provider: string;
  model: string;
  system: string;
}

function scripted(provider: string, calls: Call[], gate?: () => Promise<void>): ChatClient {
  return {
    async chat(request: ChatRequest): Promise<ChatResponse> {
      const { system, step } = session(request);
      calls.push({ provider, model: request.model, system: system.slice(0, 80) });
      if (gate) await gate();
      const steps = scripts[provider]!(request);
      const next = steps[step]?.(request) ?? { text: 'Pronto.' };
      return {
        message:
          'text' in next
            ? { role: 'assistant', content: next.text }
            : {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: `${provider}-${step}-${calls.length}`,
                    type: 'function',
                    function: { name: next.name, arguments: JSON.stringify(next.args) },
                  },
                ],
              },
        reasoning: null,
        finishReason: 'tool_calls',
        usage: { promptTokens: 100, completionTokens: 20 },
        latencyMs: 1,
      };
    },
  } as ChatClient;
}

function provider(id: string, kind: ProviderConfig['kind']): ProviderConfig {
  return {
    id,
    kind,
    name: id,
    baseUrl: 'https://example.com/v1',
    enabled: true,
    hasCredential: true,
    credentialHint: null,
    lastTest: null,
    modelsFetchedAt: null,
    createdAt: at,
  };
}

function model(providerId: string, id: string): ModelInfo {
  return {
    id,
    providerId,
    displayName: id,
    family: null,
    contextWindow: null,
    capabilities: {
      tools: 'yes',
      structuredOutput: 'unknown',
      reasoning: 'unknown',
      vision: 'unknown',
    },
    capabilitySource: 'unverified',
    pricing: null,
  } as ModelInfo;
}

function worker(id: string, name: string, role: Worker['role'], commands: string[] = []): Worker {
  return {
    id,
    name,
    role,
    beeColor: null,
    squad: [],
    description: '',
    providerId: 'openrouter',
    modelId: 'anthropic/claude-x',
    skills: [],
    tools,
    mcpServers: [],
    autoApproveCommands: commands,
    systemPrompt: '',
    limits: { ...defaultLimits, maxSteps: 20, taskTimeoutMin: 2, commandTimeoutSec: 60 },
    createdAt: at,
    updatedAt: at,
  };
}

async function mission(
  options: { gates?: Partial<Record<string, () => Promise<void>>>; enabled?: boolean } = {},
) {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'hive-teams-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, windowsHide: true }).toString();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Teste');
  git('config', 'user.email', 'teste@hive.local');
  await writeFile(
    path.join(repo, 'package.json'),
    JSON.stringify({ name: 'api', type: 'module', private: true }),
  );
  await mkdir(path.join(repo, 'src'));
  await mkdir(path.join(repo, 'test'));
  await writeFile(
    path.join(repo, 'src', 'tasks.js'),
    'export function createTask() {\n  throw new Error("TODO");\n}\n',
  );
  await writeFile(path.join(repo, 'test', 'tasks.test.js'), TESTS);
  git('add', '-A');
  git('-c', 'core.hooksPath=', 'commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();

  const db = new HiveDatabase(':memory:');
  databases.push(db);
  const repos = new Repositories(db);
  repos.saveSettings({
    ...defaultSettings,
    teams: { ...defaultSettings.teams, enabled: options.enabled ?? true },
  });
  repos.workspaces.put({
    id: 'ws',
    name: 'api',
    path: repo,
    defaultBranch: 'main',
    createdAt: at,
    lastOpenedAt: at,
  });
  for (const [id, kind] of [
    ['openrouter', 'openrouter'],
    ['chatgpt', 'chatgpt'],
    ['nvidia', 'nvidia'],
  ] as const)
    repos.providers.put(provider(id, kind));
  repos.replaceModels('openrouter', [model('openrouter', 'anthropic/claude-x')]);
  repos.replaceModels('chatgpt', [model('chatgpt', 'gpt-5.5-codex')]);
  repos.replaceModels('nvidia', [model('nvidia', 'nvidia/nemotron-3-super-120b-a12b')]);
  repos.workers.put(worker('w_claude', 'Claude', 'architect'));
  repos.workers.put(worker('w_qa', 'QA', 'qa', ['node --test']));
  repos.missions.put({
    id: 'm',
    workspaceId: 'ws',
    title: 'API de tarefas',
    objective: 'Criar uma API simples de tarefas.',
    createdAt: at,
  });
  repos.runs.put({
    id: 'run_teams1',
    missionId: 'm',
    workspaceId: 'ws',
    status: 'awaiting_plan_approval',
    baseBranch: 'main',
    baseCommit: base,
    queenWorkerId: null,
    planNotes: null,
    report: null,
    error: null,
    createdAt: at,
    finishedAt: null,
  });

  const calls: Call[] = [];
  const clients = new Map(
    Object.keys(scripts).map((id) => [id, scripted(id, calls, options.gates?.[id])] as const),
  );
  const finished: string[] = [];
  const build = () => {
    // The Scheduler and Hive Teams need each other, as in the app: the engine is set right after.
    const holder: { teams?: HiveTeams } = {};
    const scheduler = new Scheduler({
      repos,
      runtime: new NativeAgentRuntime(),
      chatFor: (providerId) => clients.get(providerId)!,
      resolveSkills: async () => ({ skills: [], missing: [] }),
      worktreeRoot: () => path.join(repo, '..', `${path.basename(repo)}-worktrees`),
      onEvent: () => undefined,
      onChange: () => undefined,
      teamTools: ({ task, worker }) => teamToolsFor(holder.teams!, repos, { task, worker }),
      onTaskFinished: (_run, task) => {
        finished.push(
          `${task.title}${task.revision ? ` (revisão ${task.revision.round})` : ''}: ${task.status}`,
        );
        holder.teams!.taskFinished(task);
      },
    });
    const teams = (holder.teams = new HiveTeams({ repos, scheduler }));
    return { scheduler, teams };
  };
  const { scheduler, teams } = build();
  // The Queen's plan: Claude leads; QA checks what the team delivers.
  scheduler.addTask('run_teams1', {
    key: 'api',
    title: 'Liderar a API de tarefas',
    description: 'Defina o contrato da API e coordene a implementação e a revisão.',
    workerId: 'w_claude',
    dependsOn: [],
    acceptanceCriteria: ['A API segue o contrato'],
    lead: true,
  });
  scheduler.addTask('run_teams1', {
    key: 'qa',
    title: 'Rodar os testes',
    description: 'Rode node --test e registre o resultado.',
    workerId: 'w_qa',
    dependsOn: ['api'],
    acceptanceCriteria: ['node --test passa'],
  });
  const tasks = () => repos.tasks.list('run_id = ?', 'run_teams1');
  const status = () => repos.runs.require('run_teams1', 'Execução').status;
  return { repo, git, repos, scheduler, teams, calls, finished, tasks, status, build };
}

async function until(check: () => boolean, what: string, timeoutMs = 60_000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Tempo esgotado esperando: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const byRole = (tasks: Task[], role: string) => tasks.filter((task) => task.team?.role === role);

describe('Hive Teams: o cenário da API de tarefas', { timeout: 120_000 }, () => {
  it('Queen → Claude lidera → Codex implementa → Nemotron revisa → Codex corrige → Claude consolida → QA testa', async () => {
    const ctx = await mission();
    ctx.scheduler.start('run_teams1');
    await until(() => ctx.status() !== 'running', 'a missão parar');
    expect(ctx.status()).toBe('review');

    // The steps happened in the scenario's order.
    expect(ctx.finished).toEqual([
      'Liderar a API de tarefas: completed',
      'Implementar a API de tarefas: completed',
      'Revisar: Implementar a API de tarefas: completed',
      'Implementar a API de tarefas (revisão 1): completed',
      'Consolidar a equipe: Liderar a API de tarefas: completed',
      'Rodar os testes: completed',
    ]);

    // Each agent spoke only to its own provider and model.
    const used = (provider: string) => [
      ...new Set(ctx.calls.filter((c) => c.provider === provider).map((c) => c.model)),
    ];
    expect(used('chatgpt')).toEqual(['gpt-5.5-codex']);
    expect(used('nvidia')).toEqual(['nvidia/nemotron-3-super-120b-a12b']);
    expect(used('openrouter')).toEqual(['anthropic/claude-x']);
    expect(
      ctx.calls.filter((c) => c.provider === 'chatgpt' && !c.system.includes('Codex')),
    ).toEqual([]);
    expect(
      ctx.calls.filter((c) => c.provider === 'nvidia' && !c.system.includes('Nemotron')),
    ).toEqual([]);

    // The agents Hive Teams created belong to this mission, under Claude.
    const members = ctx.repos.workers.list().filter((w) => w.team);
    expect(
      members.map((w) => [w.name, w.providerId, w.team?.parentAgentId, w.team?.runId]).sort(),
    ).toEqual([
      ['Codex', 'chatgpt', 'w_claude', 'run_teams1'],
      ['Nemotron', 'nvidia', 'w_claude', 'run_teams1'],
    ]);

    // The whole conversation is stored, in order, and traceable to tasks and agents.
    const messages = ctx.repos.teamMessagesOf('run_teams1');
    expect(messages.map((m) => m.kind)).toEqual([
      'spawn',
      'spawn',
      'delegation',
      'review_request',
      'report',
      'feedback',
      'report',
      'report',
      'report',
    ]);
    const feedback = messages.find((m) => m.kind === 'feedback')!;
    expect(feedback.payload).toMatchObject({ verdict: 'changes_requested' });
    expect(messages.at(-1)).toMatchObject({
      kind: 'report',
      fromAgentId: 'w_claude',
      toAgentId: null,
    });

    // QA really ran the project's tests on the team's result, and they passed.
    const qa = ctx.tasks().find((t) => t.key === 'qa')!;
    expect(qa.dependsOn).toContain(byRole(ctx.tasks(), 'consolidate')[0]!.key);
    expect(qa.result?.commands.map((c) => [c.command, c.exitCode])).toEqual([['node --test', 0]]);

    // Nothing reached the user's branch yet: the work waits for approval, isolated.
    expect(existsSync(path.join(ctx.repo, 'docs', 'api.md'))).toBe(false);
    for (const task of ctx.tasks().sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
      if (task.status === 'completed') await ctx.scheduler.approve(task.id);
    // Git may check files out with CRLF on Windows (core.autocrlf); the content is what counts.
    const read = async (...parts: string[]) =>
      (await readFile(path.join(ctx.repo, ...parts), 'utf8')).replace(/\r\n/g, '\n');
    expect(await read('src', 'tasks.js')).toBe(FIXED);
    expect(await read('docs', 'api.md')).toBe(CONTRACT);
    expect(ctx.git('status', '--porcelain')).toBe('');
    expect(ctx.status()).toBe('completed');
  });

  it('desligado, ninguém recebe as ferramentas de equipe e a missão corre como antes', async () => {
    const ctx = await mission({ enabled: false });
    ctx.scheduler.start('run_teams1');
    await until(() => ctx.status() !== 'running', 'a missão parar');
    // The lead's script tries spawn_agent: without Hive Teams the runtime refuses an unknown tool.
    expect(ctx.repos.workers.list().filter((w) => w.team)).toEqual([]);
    expect(byRole(ctx.tasks(), 'member')).toEqual([]);
    expect(ctx.repos.teamMessagesOf('run_teams1')).toEqual([]);
  });
});

describe('Hive Teams: cancelamento e recuperação', { timeout: 120_000 }, () => {
  it('cancelar no meio para tudo; retomar termina sem duplicar agentes, tarefas nem mensagens', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const ctx = await mission({ gates: { chatgpt: () => blocked } });
    ctx.scheduler.start('run_teams1');
    await until(
      () => byRole(ctx.tasks(), 'member').some((t) => t.status === 'running'),
      'o Codex começar',
    );

    ctx.scheduler.cancelRun('run_teams1');
    release();
    await until(
      () => ctx.status() === 'cancelled' && !ctx.tasks().some((t) => t.status === 'running'),
      'o cancelamento',
    );
    expect(
      ctx
        .tasks()
        .filter((t) => t.status === 'completed')
        .map((t) => t.key),
    ).toEqual(['api']);
    const agents = ctx.repos.workers.list().filter((w) => w.team).length;
    const messages = ctx.repos.teamMessagesOf('run_teams1').length;

    ctx.scheduler.start('run_teams1');
    await until(() => ctx.status() !== 'running', 'a missão terminar');
    expect(ctx.status()).toBe('review');
    expect(ctx.repos.workers.list().filter((w) => w.team)).toHaveLength(agents);
    expect(byRole(ctx.tasks(), 'member')).toHaveLength(1);
    expect(byRole(ctx.tasks(), 'review')).toHaveLength(1);
    expect(byRole(ctx.tasks(), 'consolidate')).toHaveLength(1);
    expect(ctx.repos.teamMessagesOf('run_teams1').filter((m) => m.kind === 'spawn')).toHaveLength(
      2,
    );
    expect(ctx.repos.teamMessagesOf('run_teams1').length).toBeGreaterThan(messages);
  });

  it('o aplicativo cai com o Codex trabalhando; ao abrir de novo, a missão retoma e termina', async () => {
    let releaseHung!: () => void;
    const hung = new Promise<void>((resolve) => (releaseHung = resolve));
    let gate: () => Promise<void> = () => hung;
    const ctx = await mission({ gates: { chatgpt: () => gate() } });
    ctx.scheduler.start('run_teams1');
    await until(
      () => byRole(ctx.tasks(), 'member').some((t) => t.status === 'running'),
      'o Codex começar',
    );

    // A new Scheduler over the same database, as when Hive opens again after closing mid-run.
    gate = async () => undefined;
    const reopened = ctx.build();
    reopened.scheduler.recover();
    // Reopening fails what was running; with the leader's work done, the mission waits in review.
    expect(ctx.status()).toBe('review');
    expect(byRole(ctx.tasks(), 'member')[0]!.status).toBe('failed');

    reopened.scheduler.start('run_teams1');
    await until(() => ctx.status() !== 'running', 'a missão terminar depois de reabrir');
    expect(ctx.status()).toBe('review');
    expect(ctx.tasks().find((t) => t.key === 'qa')!.result?.commands[0]?.exitCode).toBe(0);
    expect(ctx.repos.workers.list().filter((w) => w.team)).toHaveLength(2);
    expect(byRole(ctx.tasks(), 'member')).toHaveLength(1);

    // The closed app's session is still stranded in this process: end it before the database
    // closes, as the operating system would have when Hive closed.
    ctx.scheduler.cancelTask(byRole(ctx.tasks(), 'member')[0]!.id);
    releaseHung();
    await until(() => !ctx.scheduler.isActive('run_teams1'), 'a sessão antiga terminar');
  });

  it('a falha de um membro segura o QA; repetir o membro libera o resto da equipe', async () => {
    let failures = 1;
    const ctx = await mission({
      gates: {
        chatgpt: async () => {
          if (failures-- > 0) throw new ProviderError('O modelo recusou o pedido.', 400);
        },
      },
    });
    ctx.scheduler.start('run_teams1');
    await until(() => ctx.status() !== 'running', 'a missão parar na falha', 15_000).catch(
      (error: unknown) => {
        throw new Error(
          `${String(error)} ${JSON.stringify(ctx.tasks().map((t) => [t.key, t.status, t.error?.slice(0, 120)]))}`,
        );
      },
    );
    expect(ctx.status()).toBe('review');
    const member = byRole(ctx.tasks(), 'member')[0]!;
    expect(member.status).toBe('failed');
    expect(ctx.tasks().find((t) => t.key === 'qa')!.status).toBe('cancelled');

    ctx.scheduler.retry(member.id);
    await until(
      () =>
        ctx.status() !== 'running' &&
        ctx.tasks().find((t) => t.key === 'qa')!.status === 'completed',
      'o QA depois da repetição',
      60_000,
    );
    expect(byRole(ctx.tasks(), 'consolidate')[0]!.status).toBe('completed');
  });
});
