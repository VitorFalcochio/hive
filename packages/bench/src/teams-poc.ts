/**
 * Hive Teams proof of concept with real providers (T8). Run through `npm run teams:poc`
 * (scripts/teams-poc.mjs), which bundles this file and starts it in Electron so the keys saved in
 * Hive's development data (.local/data) can be read without ever being shown.
 *
 * It costs nothing extra: before anything runs, every model it would use is checked to be free
 * (a free model, a free tier, or the ChatGPT plan the user already pays), and the run stops if
 * one is not. The development database is only read, never migrated; the one write is a ChatGPT
 * token refresh, saved encrypted exactly as Hive saves it, so the user's sign-in keeps working.
 * Everything else happens in a database and a sample project of this run's own.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NativeAgentRuntime } from '@hive/agents';
import {
  defaultLimits,
  defaultSettings,
  rolePresets,
  usageCost,
  type ModelInfo,
  type ProviderConfig,
  type Task,
  type Worker,
} from '@hive/core';
import {
  HiveTeams,
  Scheduler,
  costsNothingExtra,
  planMission,
  teamToolsFor,
} from '@hive/orchestrator';
import { HiveDatabase, Repositories } from '@hive/persistence';
import {
  ChatGPTPlanClient,
  ChatGPTSession,
  GatedClient,
  OpenAICompatibleClient,
  ProviderGate,
  type ChatClient,
  type ChatGPTCredentials,
} from '@hive/providers';
import { errorMessage } from '@hive/shared';
import { benchRoot } from './workspace';

/* ---------------------------------------------------------------- the agreed setup */

/** What the user agreed to: a free leader on NVIDIA, Codex and the Queen on the ChatGPT plan. */
const SETUP = {
  queen: { kind: 'chatgpt', model: 'gpt-6.1-sol' },
  leader: { kind: 'nvidia', model: 'moonshotai/kimi-k3.1-pro', name: 'Líder técnico (Kimi)' },
  qa: { kind: 'kilo', model: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'QA' },
} as const;
const RUN_LIMIT_MIN = 45;

const repoRoot = path.resolve(benchRoot, '..', '..');
const dataDir = path.resolve(process.env.HIVE_DATA_DIR || path.join(repoRoot, '.local', 'data'));
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
/** A paused run picks up where it stopped: same database, same sample project, same team. */
const resuming = process.env.HIVE_POC_RESUME ? path.resolve(process.env.HIVE_POC_RESUME) : null;
const outDir = resuming ?? path.join(repoRoot, '.local', 'teams-poc', stamp);

interface ElectronLike {
  app: {
    setPath(name: string, value: string): void;
    whenReady(): Promise<void>;
    exit(code: number): void;
  };
  safeStorage: { decryptString(encrypted: Buffer): string; encryptString(text: string): Buffer };
}
const electron = process.versions.electron
  ? (createRequire(import.meta.url)('electron') as ElectronLike)
  : null;
if (electron) {
  electron.app.setPath('userData', dataDir);
  electron.app.setPath('sessionData', path.join(dataDir, 'session'));
}
const launcher = Number(process.env.HIVE_BENCH_PARENT);
if (launcher)
  setInterval(() => {
    try {
      process.kill(launcher, 0);
    } catch {
      console.error('O processo que iniciou a prova de conceito terminou; encerrando.');
      electron?.app.exit(1);
    }
  }, 2_000).unref();

/* ---------------------------------------------------------------- the sample project */

const README = `# API de tarefas

Módulo ES em \`src/tasks.js\`, sem dependências, testado com \`node --test\`.
`;
const TESTS = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTask, listTasks, completeTask, resetTasks } from '../src/tasks.js';

test('cria tarefas abertas com ids crescentes', () => {
  resetTasks();
  assert.deepEqual(createTask('Comprar pão'), { id: 1, title: 'Comprar pão', done: false });
  assert.equal(createTask('Pagar conta').id, 2);
});

test('recusa título vazio ou só com espaços', () => {
  resetTasks();
  assert.throws(() => createTask(''), /title is required/);
  assert.throws(() => createTask('   '), /title is required/);
});

test('lista e conclui tarefas', () => {
  resetTasks();
  const a = createTask('A');
  createTask('B');
  assert.deepEqual(completeTask(a.id), { ...a, done: true });
  assert.deepEqual(listTasks().map((t) => t.done), [true, false]);
  assert.throws(() => completeTask(99), /task not found/);
});
`;
const OBJECTIVE = `Criar uma API simples de tarefas em src/tasks.js (módulo ES, sem dependências) que passe nos testes de test/tasks.test.js: createTask(title), listTasks(), completeTask(id) e resetTasks(); título vazio lança Error("title is required") e id desconhecido lança Error("task not found").

Use o Hive Teams: o líder técnico escreve o contrato da API em docs/api.md, cria um agente Codex (spawn_agent com family "codex") para implementar e um agente Nemotron (family "nemotron") para revisar o contrato e os testes, delega a implementação, pede a revisão e, ao ser retomado, relata à Queen. Um QA roda "node --test" no resultado final.`;

async function sampleProject(): Promise<string> {
  const dir = path.join(outDir, 'projeto');
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await mkdir(path.join(dir, 'test'), { recursive: true });
  await writeFile(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'api-tarefas', type: 'module', private: true, scripts: { test: 'node --test' } }, null, 2)}\n`,
  );
  await writeFile(path.join(dir, 'README.md'), README);
  await writeFile(
    path.join(dir, 'src', 'tasks.js'),
    "export function createTask() {\n  throw new Error('TODO');\n}\n",
  );
  await writeFile(path.join(dir, 'test', 'tasks.test.js'), TESTS);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, windowsHide: true }).toString();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Hive Teams PoC');
  git('config', 'user.email', 'poc@hive.local');
  git('config', 'core.autocrlf', 'false');
  git('add', '-A');
  git('-c', 'core.hooksPath=', 'commit', '-q', '-m', 'base');
  return dir;
}

/* ---------------------------------------------------------------- providers, read-only */

interface Source {
  providers: ProviderConfig[];
  models: Map<string, ModelInfo[]>;
  secret: (providerId: string) => string | null;
  saveChatGPT: (providerId: string, credentials: ChatGPTCredentials) => void;
}

function openSource(): Source {
  const db = new DatabaseSync(path.join(dataDir, 'hive.sqlite'), { readOnly: true });
  const providers = db
    .prepare('SELECT data FROM providers')
    .all()
    .map((row) => JSON.parse(String(row.data)) as ProviderConfig);
  const models = new Map<string, ModelInfo[]>();
  for (const provider of providers)
    models.set(
      provider.id,
      db
        .prepare('SELECT data FROM models WHERE provider_id = ?')
        .all(provider.id)
        .map((row) => JSON.parse(String(row.data)) as ModelInfo),
    );
  const ciphertexts = new Map(
    db
      .prepare('SELECT id, ciphertext FROM secrets')
      .all()
      .map((row) => [String(row.id), Buffer.from(row.ciphertext as Uint8Array)]),
  );
  db.close();
  return {
    providers,
    models,
    secret: (id) => {
      const encrypted = ciphertexts.get(id);
      return encrypted && electron ? electron.safeStorage.decryptString(encrypted) : null;
    },
    // A refreshed ChatGPT token replaces the old one, which no longer works: saved like Hive does.
    saveChatGPT: (id, credentials) => {
      if (!electron) return;
      const writer = new DatabaseSync(path.join(dataDir, 'hive.sqlite'));
      try {
        writer
          .prepare('UPDATE secrets SET ciphertext = ?, updated_at = ? WHERE id = ?')
          .run(
            electron.safeStorage.encryptString(JSON.stringify(credentials)),
            new Date().toISOString(),
            id,
          );
      } finally {
        writer.close();
      }
    },
  };
}

/** Counts every model call by provider and model, for the report. */
interface CallCount {
  provider: string;
  model: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
}

function counted(
  client: ChatClient,
  providerKind: string,
  counts: Map<string, CallCount>,
): ChatClient {
  return {
    ...client,
    chat: async (request, signal) => {
      const response = await client.chat(request, signal);
      const key = `${providerKind}\u0000${request.model}`;
      const entry = counts.get(key) ?? {
        provider: providerKind,
        model: request.model,
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
      };
      entry.calls++;
      entry.promptTokens += response.usage?.promptTokens ?? 0;
      entry.completionTokens += response.usage?.completionTokens ?? 0;
      counts.set(key, entry);
      return response;
    },
  } as ChatClient;
}

/* ---------------------------------------------------------------- the run */

async function main() {
  if (!electron)
    throw new Error('Rode com npm run teams:poc: a chave salva no Hive só é lida pelo Electron.');
  await electron.app.whenReady();
  await mkdir(outDir, { recursive: true });
  const source = openSource();
  const byKind = (kind: string) =>
    source.providers.find(
      (provider) => provider.kind === kind && provider.enabled && provider.hasCredential,
    );
  const pick = (kind: string, modelId: string) => {
    const provider = byKind(kind);
    if (!provider) throw new Error(`Nenhum provedor ${kind} configurado e ativo em ${dataDir}.`);
    const model = source.models.get(provider.id)?.find((item) => item.id === modelId);
    if (!model) throw new Error(`${provider.name} não lista o modelo ${modelId}.`);
    if (!costsNothingExtra(provider, model))
      throw new Error(`${provider.name} / ${modelId} teria custo. Nada foi executado.`);
    return { provider, model };
  };
  const queen = pick(SETUP.queen.kind, SETUP.queen.model);
  const leader = pick(SETUP.leader.kind, SETUP.leader.model);
  const qa = pick(SETUP.qa.kind, SETUP.qa.model);

  const repo = resuming ? path.join(outDir, 'projeto') : await sampleProject();
  const db = new HiveDatabase(path.join(outDir, 'hive.sqlite'));
  const repos = new Repositories(db);
  for (const provider of source.providers) {
    repos.providers.put(provider);
    repos.replaceModels(provider.id, source.models.get(provider.id) ?? []);
  }
  let fresh: { queenWorker: Worker; leaderWorker: Worker; qaWorker: Worker } | null = null;
  if (!resuming) {
    repos.saveSettings({
      ...defaultSettings,
      maxConcurrentTasks: 2,
      commandApproval: 'safe',
      teams: {
        ...defaultSettings.teams,
        enabled: true,
        freeOnly: true,
        maxAgentsPerRun: 2,
        maxTeamSize: 2,
        maxReviewRounds: 1,
        teamTokenBudget: 1_500_000,
      },
      autopilot: {
        ...defaultSettings.autopilot,
        safeCommands: ['node --test', 'node --test *', 'npm test', 'npm test *'],
      },
    });
    const now = new Date().toISOString();
    const worker = (
      id: string,
      name: string,
      role: Worker['role'],
      providerId: string,
      modelId: string,
      limits: Partial<Worker['limits']>,
    ): Worker =>
      repos.workers.put({
        id,
        name,
        role,
        beeColor: null,
        squad: [],
        description: rolePresets[role].description,
        providerId,
        modelId,
        skills: [],
        tools: rolePresets[role].tools,
        mcpServers: [],
        autoApproveCommands: role === 'queen' ? [] : ['node --test'],
        systemPrompt: rolePresets[role].systemPrompt,
        limits: { ...defaultLimits, ...limits },
        createdAt: now,
        updatedAt: now,
      });
    const queenWorker = worker('w_queen', 'Queen', 'queen', queen.provider.id, queen.model.id, {});
    const leaderWorker = worker(
      'w_lider',
      SETUP.leader.name,
      'architect',
      leader.provider.id,
      leader.model.id,
      { maxSteps: 30, maxTokens: 400_000, taskTimeoutMin: 20 },
    );
    const qaWorker = worker('w_qa', SETUP.qa.name, 'qa', qa.provider.id, qa.model.id, {
      maxSteps: 12,
      maxTokens: 200_000,
      taskTimeoutMin: 10,
    });
    repos.workspaces.put({
      id: 'ws',
      name: 'api-tarefas',
      path: repo,
      defaultBranch: 'main',
      createdAt: now,
      lastOpenedAt: now,
    });
    repos.missions.put({
      id: 'm',
      workspaceId: 'ws',
      title: 'API de tarefas',
      objective: OBJECTIVE,
      createdAt: now,
    });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
    repos.runs.put({
      id: 'run_poc',
      missionId: 'm',
      workspaceId: 'ws',
      status: 'awaiting_plan_approval',
      baseBranch: 'main',
      baseCommit: base,
      queenWorkerId: queenWorker.id,
      planNotes: null,
      report: null,
      error: null,
      createdAt: now,
      finishedAt: null,
    });
    fresh = { queenWorker, leaderWorker, qaWorker };
  }

  const counts = new Map<string, CallCount>();
  const gates = new Map<string, ProviderGate>();
  const sessions = new Map<string, ChatGPTSession>();
  const chatFor = (providerId: string): ChatClient => {
    const provider = repos.providers.require(providerId, 'Provedor');
    let gate = gates.get(providerId);
    if (!gate) gates.set(providerId, (gate = new ProviderGate()));
    let client: ChatClient;
    if (provider.kind === 'chatgpt') {
      let session = sessions.get(providerId);
      if (!session) {
        const raw = source.secret(providerId);
        if (!raw) throw new Error('Entre com a conta do ChatGPT no Hive de desenvolvimento.');
        // A refresh that fails is not saved as "signed out": the user's sign-in is left alone.
        session = new ChatGPTSession(JSON.parse(raw) as ChatGPTCredentials, (next) => {
          if (next) source.saveChatGPT(providerId, next);
        });
        sessions.set(providerId, session);
      }
      client = new ChatGPTPlanClient(providerId, session, fetch, provider.baseUrl);
    } else {
      client = new OpenAICompatibleClient({
        providerId,
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        apiKey: source.secret(providerId),
      });
    }
    return counted(new GatedClient(client as never, gate), provider.kind, counts);
  };

  const log: string[] = [];
  const say = (line: string) => {
    log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
    console.log(`  ${line}`);
  };
  const holder: { teams?: HiveTeams } = {};
  const scheduler = new Scheduler({
    repos,
    runtime: new NativeAgentRuntime(),
    chatFor,
    resolveSkills: async () => ({ skills: [], missing: [] }),
    worktreeRoot: () => path.join(outDir, 'worktrees'),
    onEvent: (event) => {
      if (event.type === 'team' || event.type === 'task.status' || event.level === 'error')
        say(event.message);
    },
    onChange: () => undefined,
    unattended: () => true,
    teamTools: ({ task, worker: assigned }) =>
      teamToolsFor(holder.teams!, repos, { task, worker: assigned }),
    onTaskFinished: (_run, task) => holder.teams!.taskFinished(task),
  });
  holder.teams = new HiveTeams({ repos, scheduler });

  console.log(
    `Hive Teams PoC · dados: ${dataDir} · saída: ${outDir}${resuming ? ' · retomando' : ''}`,
  );
  const started = Date.now();
  let leadByQueen: boolean;
  let planUsage = { promptTokens: 0, completionTokens: 0 };
  if (fresh) {
    // 1. The Queen plans, with real calls on the ChatGPT plan.
    say(`Queen planejando em ${queen.provider.name} / ${queen.model.id}…`);
    const planned = await planMission({
      title: 'API de tarefas',
      objective: OBJECTIVE,
      workers: [fresh.leaderWorker, fresh.qaWorker],
      projectContext: `${README}\nArquivos: package.json, src/tasks.js, test/tasks.test.js.`,
      chat: chatFor(queen.provider.id),
      model: queen.model.id,
      queen: fresh.queenWorker,
      teams: true,
    });
    leadByQueen = planned.plan.tasks.some((task) => task.lead);
    planUsage = planned.usage;
    for (const task of planned.plan.tasks) {
      // The Queen is asked to pick a lead; if she did not, the leader's task is marked so the
      // scenario can be measured, and the report says so.
      const lead = task.lead || (!leadByQueen && task.workerId === fresh.leaderWorker.id);
      scheduler.addTask('run_poc', { ...task, lead: lead || undefined });
    }
    repos.setValue('poc.leadByQueen', String(leadByQueen));
    repos.setValue('poc.planUsage', JSON.stringify(planUsage));
    say(
      `Plano da Queen: ${planned.plan.tasks.length} tarefa(s); líder marcado pela Queen: ${leadByQueen ? 'sim' : 'não'}.`,
    );
  } else {
    // A paused run: what was running when it stopped is failed and tried again, nothing else.
    const saved = repos.getValue('poc.leadByQueen');
    leadByQueen =
      saved === null
        ? repos.tasks.list('run_id = ?', 'run_poc').some((task) => task.team?.role === 'lead')
        : saved === 'true';
    planUsage = JSON.parse(repos.getValue('poc.planUsage') ?? JSON.stringify(planUsage));
    scheduler.recover();
    say('Retomando a rodada pausada de onde parou.');
  }

  // 2-9. The team works.
  scheduler.start('run_poc');
  const deadline = started + RUN_LIMIT_MIN * 60_000;
  const status = () => repos.runs.require('run_poc', 'Execução').status;
  while (status() === 'running' || scheduler.isActive('run_poc')) {
    if (Date.now() > deadline) {
      say(`Tempo de ${RUN_LIMIT_MIN} min esgotado; cancelando.`);
      scheduler.cancelRun('run_poc');
      while (scheduler.isActive('run_poc'))
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  // 10. The delivery is applied to the sample project and its tests are run once more.
  const tasks = repos.tasks
    .list('run_id = ?', 'run_poc')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const applied: string[] = [];
  for (const task of tasks)
    if (task.status === 'completed')
      try {
        await scheduler.approve(task.id);
        applied.push(task.title);
      } catch (error) {
        say(`Não aplicada: ${task.title}: ${errorMessage(error)}`);
      }
  let finalTests: string;
  let testsPass = false;
  try {
    // The launcher's own Node, not Electron's binary.
    finalTests = execFileSync(process.env.HIVE_NODE || 'node', ['--test'], {
      cwd: repo,
      encoding: 'utf8',
    });
    testsPass = true;
  } catch (error) {
    finalTests = String((error as { stdout?: string }).stdout ?? errorMessage(error));
  }

  await writeReport({
    repos,
    tasks: repos.tasks.list('run_id = ?', 'run_poc'),
    counts,
    leadByQueen,
    testsPass,
    finalTests,
    applied,
    log,
    seconds: Math.round((Date.now() - started) / 1000),
    planUsage,
  });
  db.close();
  console.log(`\nRelatório: ${path.join(outDir, 'report.md')}`);
}

/* ---------------------------------------------------------------- the report */

async function writeReport(input: {
  repos: Repositories;
  tasks: Task[];
  counts: Map<string, CallCount>;
  leadByQueen: boolean;
  testsPass: boolean;
  finalTests: string;
  applied: string[];
  log: string[];
  seconds: number;
  planUsage: { promptTokens: number; completionTokens: number };
}) {
  const { repos, tasks, counts } = input;
  const messages = repos.teamMessagesOf('run_poc');
  const workers = new Map(repos.workers.list().map((item) => [item.id, item]));
  const name = (id: string | null) => (id ? (workers.get(id)?.name ?? id) : 'Queen');
  const members = repos.workers.list().filter((item) => item.team?.runId === 'run_poc');
  const role = (task: Task) => task.team?.role ?? '—';
  const by = (kind: string) => messages.filter((message) => message.kind === kind);
  const memberTask = tasks.find((task) => task.team?.role === 'member');
  const steps: [string, boolean][] = [
    ['1. A Queen planejou a missão', tasks.length > 0],
    ['2. A Queen designou um líder', input.leadByQueen],
    [
      '3. O líder definiu o contrato e pediu um agente Codex',
      members.some((m) => /codex/i.test(m.name)) || members.some((m) => m.role === 'backend'),
    ],
    [
      '4. O Hive Teams validou e criou o membro com trabalho atribuído',
      by('delegation').length > 0,
    ],
    ['5. O líder pediu um agente Nemotron para revisar', by('review_request').length > 0],
    ['6. O revisor enviou feedback estruturado', by('feedback').length > 0],
    [
      '7. O autor corrigiu depois do feedback',
      (memberTask?.revision?.round ?? 0) > 0 && memberTask?.status === 'completed',
    ],
    [
      '8. O líder consolidou e relatou à Queen',
      messages.some((m) => m.kind === 'report' && m.toAgentId === null),
    ],
    [
      '9. O QA rodou os testes e registrou o resultado',
      tasks.some(
        (t) =>
          workers.get(t.workerId ?? '')?.role === 'qa' &&
          t.result?.commands.some((c) => /node --test|npm test/.test(c.command)),
      ),
    ],
    ['10. A entrega ficou para aprovação e foi aplicada', input.applied.length > 0],
  ];
  const cost = (
    provider: string,
    model: string,
    usage: { promptTokens: number; completionTokens: number },
  ) => {
    const providerId = repos.providers.list().find((p) => p.kind === provider)?.id;
    const info = providerId ? repos.getModel(providerId, model) : null;
    const usd = info ? usageCost(info, usage) : null;
    return usd === null ? 'sem preço no catálogo' : usd === 0 ? 'grátis' : `US$ ${usd.toFixed(4)}`;
  };
  const lines = [
    '# Hive Teams — prova de conceito com provedores reais',
    '',
    `Duração: ${Math.round(input.seconds / 60)} min · testes finais: **${input.testsPass ? 'passaram' : 'falharam'}**`,
    '',
    '## Os 10 passos',
    '',
    ...steps.map(([label, ok]) => `- ${ok ? '✅' : '❌'} ${label}`),
    '',
    '## Chamadas por provedor e modelo',
    '',
    '| Provedor | Modelo | Chamadas | Tokens enviados | Tokens gerados | Custo |',
    '|---|---|---|---|---|---|',
    ...[...counts.values()].map(
      (c) =>
        `| ${c.provider} | ${c.model} | ${c.calls} | ${c.promptTokens.toLocaleString('pt-BR')} | ${c.completionTokens.toLocaleString('pt-BR')} | ${cost(c.provider, c.model, c)} |`,
    ),
    '',
    '## Agentes criados pelo Hive Teams',
    '',
    ...(members.length
      ? members.map(
          (m) =>
            `- ${m.name} (${m.role}) — ${m.modelId}, criado por ${name(m.team?.parentAgentId ?? null)}`,
        )
      : ['- nenhum']),
    '',
    '## Tarefas',
    '',
    '| Tarefa | Papel | Agente | Estado | Revisões | Erro |',
    '|---|---|---|---|---|---|',
    ...tasks.map(
      (t) =>
        `| ${t.title} | ${role(t)} | ${name(t.workerId)} | ${t.status} | ${t.revision?.round ?? 0} | ${(t.error ?? '').slice(0, 120).replace(/\|/g, '/')} |`,
    ),
    '',
    '## Mensagens da equipe',
    '',
    ...(messages.length
      ? messages.map(
          (m) =>
            `- **${m.kind}** ${name(m.fromAgentId)} → ${name(m.toAgentId)}: ${m.subject}${typeof m.payload.verdict === 'string' ? ` [${m.payload.verdict}]` : ''}`,
        )
      : ['- nenhuma']),
    '',
    '## Testes no resultado aplicado',
    '',
    '```',
    input.finalTests.slice(-3_000),
    '```',
    '',
    '## Registro',
    '',
    '```',
    ...input.log.slice(-200),
    '```',
  ];
  await writeFile(path.join(outDir, 'report.md'), `${lines.join('\n')}\n`);
  await writeFile(
    path.join(outDir, 'results.json'),
    JSON.stringify(
      {
        steps,
        counts: [...counts.values()],
        tasks,
        messages,
        members,
        testsPass: input.testsPass,
        planUsage: input.planUsage,
      },
      null,
      2,
    ),
  );
}

main()
  .then(() => electron?.app.exit(0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    electron?.app.exit(1);
  });
