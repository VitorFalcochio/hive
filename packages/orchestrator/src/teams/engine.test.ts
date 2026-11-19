import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultLimits,
  type ModelInfo,
  type ProviderConfig,
  type Task,
  type Worker,
} from '@hive/core';
import type { AgentRuntime } from '@hive/agents';
import { HiveDatabase, Repositories } from '@hive/persistence';
import { Scheduler } from '../scheduler';
import { HiveTeams, memberPrivileges, type SpawnInput } from './engine';
import { chooseTeamModel } from './models';

/*
 * Hive Teams' rules, checked on a real Scheduler and database. The mission is not running, so
 * nothing is executed: these tests look only at what is decided and stored.
 */
const databases: HiveDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const at = '2026-01-01T00:00:00.000Z';

function provider(
  id: string,
  kind: ProviderConfig['kind'],
  patch: Partial<ProviderConfig> = {},
): ProviderConfig {
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
    ...patch,
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

const claude: Worker = {
  id: 'w_claude',
  name: 'Claude',
  role: 'architect',
  beeColor: null,
  squad: [],
  description: 'Líder técnico',
  providerId: 'openrouter',
  modelId: 'anthropic/claude-x',
  skills: [],
  tools: ['list_dir', 'read_file', 'search', 'write_file', 'replace_in_file', 'run_command'],
  mcpServers: ['docs'],
  autoApproveCommands: ['npm test'],
  systemPrompt: '',
  limits: { ...defaultLimits, maxSteps: 60, maxTokens: 2_000_000 },
  createdAt: at,
  updatedAt: at,
};

function setup() {
  const db = new HiveDatabase(':memory:');
  databases.push(db);
  const repos = new Repositories(db);
  repos.workspaces.put({
    id: 'ws',
    name: 'p',
    path: '/p',
    defaultBranch: 'main',
    createdAt: at,
    lastOpenedAt: at,
  });
  repos.missions.put({
    id: 'm',
    workspaceId: 'ws',
    title: 'API de tarefas',
    objective: 'o',
    createdAt: at,
  });
  repos.runs.put({
    id: 'run',
    missionId: 'm',
    workspaceId: 'ws',
    status: 'awaiting_plan_approval',
    baseBranch: 'main',
    baseCommit: 'abc',
    queenWorkerId: null,
    planNotes: null,
    report: null,
    error: null,
    createdAt: at,
    finishedAt: null,
  });
  repos.providers.put(provider('chatgpt', 'chatgpt'));
  repos.providers.put(provider('openrouter', 'openrouter'));
  repos.providers.put(provider('nvidia', 'nvidia'));
  repos.providers.put(provider('desligado', 'groq', { enabled: false }));
  repos.replaceModels('chatgpt', [model('chatgpt', 'gpt-5.5'), model('chatgpt', 'gpt-5.5-codex')]);
  repos.replaceModels('openrouter', [
    model('openrouter', 'openai/gpt-5.5-codex'),
    model('openrouter', 'nvidia/nemotron-3-super-120b-a12b:free'),
    model('openrouter', 'anthropic/claude-x'),
  ]);
  repos.replaceModels('nvidia', [model('nvidia', 'nvidia/nemotron-3-super-120b-a12b')]);
  repos.workers.put(claude);
  repos.workers.put({ ...claude, id: 'w_qa', name: 'QA', role: 'qa' });
  const task = (key: string, patch: Partial<Task> = {}): Task =>
    repos.tasks.put({
      id: `task_${key}`,
      runId: 'run',
      key,
      title: `Tarefa ${key}`,
      description: 'd',
      workerId: 'w_claude',
      dependsOn: [],
      acceptanceCriteria: ['ok'],
      status: 'pending',
      workerState: 'idle',
      attempt: 1,
      branch: null,
      startCommit: null,
      worktreePath: null,
      result: null,
      error: null,
      createdAt: at,
      startedAt: null,
      finishedAt: null,
      ...patch,
    });
  const lead = task('lead', {
    status: 'running',
    team: { role: 'lead', leadTaskId: 'task_lead', requestId: null },
  });
  const qa = task('qa', { workerId: 'w_qa', dependsOn: ['lead'] });
  const scheduler = new Scheduler({
    repos,
    runtime: {} as AgentRuntime,
    chatFor: () => ({ chat: () => Promise.reject(new Error('sem rede nos testes')) }) as never,
    resolveSkills: async () => ({ skills: [], missing: [] }),
    worktreeRoot: () => '/wt',
    onEvent: () => undefined,
    onChange: () => undefined,
  });
  const teams = new HiveTeams({ repos, scheduler });
  const get = (id: string) => repos.tasks.require(id, 'Tarefa');
  return { repos, scheduler, teams, lead, qa, task, get };
}

const codex: SpawnInput = {
  key: 'codex',
  name: 'Codex',
  role: 'backend',
  model: { family: 'codex' },
};
const nemotron: SpawnInput = {
  key: 'nemotron',
  name: 'Nemotron',
  role: 'reviewer',
  model: { family: 'nemotron' },
};

describe('Hive Teams: criação de agentes', () => {
  it('cria um membro real da missão, no provedor configurado preferido para a família', () => {
    const { repos, teams } = setup();
    const request = teams.spawnAgent('task_lead', codex);
    expect(request).toMatchObject({
      status: 'accepted',
      kind: 'spawn_agent',
      requestedByAgentId: 'w_claude',
    });
    const agent = repos.workers.require(request.result.agentId!, 'Agente');
    // The official ChatGPT sign-in comes before OpenRouter for Codex.
    expect(agent).toMatchObject({
      providerId: 'chatgpt',
      modelId: 'gpt-5.5-codex',
      role: 'backend',
    });
    expect(agent.team).toEqual({
      runId: 'run',
      parentAgentId: 'w_claude',
      createdByAgentId: 'w_claude',
      spawnRequestId: request.id,
      depth: 1,
    });
    const reviewer = repos.workers.require(
      teams.spawnAgent('task_lead', nemotron).result.agentId!,
      'Agente',
    );
    expect(reviewer).toMatchObject({
      providerId: 'nvidia',
      modelId: 'nvidia/nemotron-3-super-120b-a12b',
    });
    expect(repos.teamMessagesOf('run').map((m) => [m.kind, m.subject])).toEqual([
      ['spawn', 'Agente criado: Codex'],
      ['spawn', 'Agente criado: Nemotron'],
    ]);
  });

  it('pedir de novo com a mesma chave devolve o mesmo agente, sem criar outro', () => {
    const { repos, teams } = setup();
    const first = teams.spawnAgent('task_lead', codex);
    const again = teams.spawnAgent('task_lead', { ...codex, name: 'Outro nome' });
    expect(again.id).toBe(first.id);
    expect(again.result.agentId).toBe(first.result.agentId);
    expect(repos.workers.list().filter((w) => w.team)).toHaveLength(1);
    expect(repos.teamMessagesOf('run')).toHaveLength(1);
  });

  it('um membro nunca recebe mais que o líder', () => {
    const { teams } = setup();
    const refused = (patch: Partial<SpawnInput>, reason: RegExp) =>
      expect(
        teams.spawnAgent('task_lead', { ...codex, key: `k${Math.random()}`, ...patch }),
      ).toMatchObject({
        status: 'rejected',
        reason: expect.stringMatching(reason),
      });
    refused({ tools: ['read_file', 'web_fetch'] }, /web_fetch não está entre as do líder/);
    refused({ autoApproveCommands: ['npm publish'] }, /npm publish/);
    refused({ mcpServers: ['github'] }, /github/);
    refused({ limits: { maxSteps: 500 } }, /maxSteps/);
    // Unsaid, a member gets the role's tools the leader also has, and the leader's limits at most.
    const granted = memberPrivileges(claude, 'reviewer', {});
    expect(granted).toMatchObject({ autoApproveCommands: [], mcpServers: [] });
    if ('tools' in granted) {
      expect(granted.tools.every((tool) => claude.tools.includes(tool))).toBe(true);
      expect(granted.limits.maxSteps).toBeLessThanOrEqual(claude.limits.maxSteps);
    }
  });

  it('respeita os limites globais e da equipe', () => {
    const { repos, teams } = setup();
    const settings = repos.getSettings();
    repos.saveSettings({
      ...settings,
      teams: { ...settings.teams, maxTeamSize: 2, teamTokenBudget: 3_000_000 },
    });
    expect(teams.spawnAgent('task_lead', codex).status).toBe('accepted');
    // The first member took 2M of the leader's limit; 1M is left of the team's 3M.
    const second = teams.spawnAgent('task_lead', nemotron);
    expect(repos.workers.require(second.result.agentId!, 'Agente').limits.maxTokens).toBe(
      1_000_000,
    );
    expect(teams.spawnAgent('task_lead', { ...codex, key: 'terceiro' })).toMatchObject({
      status: 'rejected',
      reason: expect.stringMatching(/limite 2/),
    });

    repos.saveSettings({ ...settings, teams: { ...settings.teams, maxAgentsPerRun: 2 } });
    expect(teams.spawnAgent('task_lead', { ...codex, key: 'quarto' })).toMatchObject({
      status: 'rejected',
      reason: expect.stringMatching(/limite 2/),
    });
  });

  it('só um líder em execução pede, e quem foi criado por um líder não cria outros', () => {
    const { repos, teams, task } = setup();
    expect(() => teams.spawnAgent('task_qa', codex)).toThrow(/não lidera/);
    task('parado', { team: { role: 'lead', leadTaskId: 'task_parado', requestId: null } });
    expect(() => teams.spawnAgent('task_parado', codex)).toThrow(/em execução/);
    // A member made leader of its own task still sits one level down: depth 1 is the limit.
    const member = repos.workers.require(
      teams.spawnAgent('task_lead', codex).result.agentId!,
      'Agente',
    );
    task('sublider', {
      workerId: member.id,
      status: 'running',
      team: { role: 'lead', leadTaskId: 'task_sublider', requestId: null },
    });
    expect(teams.spawnAgent('task_sublider', { ...codex, key: 'neto' })).toMatchObject({
      status: 'rejected',
      reason: expect.stringMatching(/nível máximo/),
    });
  });

  it('só usa provedores já configurados e ativos', () => {
    const { repos } = setup();
    const choose = (profile: Parameters<typeof chooseTeamModel>[0]) =>
      chooseTeamModel(profile, repos.providers.list(), (id) => repos.listModels(id));
    expect(choose({ providerId: 'desligado', model: 'llama' })).toMatchObject({ ok: false });
    expect(choose({ family: 'gemini' })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/Nenhum provedor/),
    });
    expect(choose({ family: 'claude' })).toEqual({
      ok: true,
      providerId: 'openrouter',
      modelId: 'anthropic/claude-x',
    });
  });
});

describe('Hive Teams: delegação', () => {
  it('cria a tarefa do membro, a sessão de consolidação do líder, e faz o QA esperar a equipe', () => {
    const { repos, teams, get } = setup();
    const agentId = teams.spawnAgent('task_lead', codex).result.agentId!;
    const request = teams.delegate('task_lead', {
      key: 'implementar',
      agentId,
      title: 'Implementar a API',
      description: 'Siga o contrato em docs/api.md.',
      acceptanceCriteria: ['Testes passam'],
    });
    expect(request.status).toBe('accepted');
    const work = get(request.result.taskId!);
    expect(work).toMatchObject({
      workerId: agentId,
      parentTaskId: 'task_lead',
      dependsOn: ['lead'],
      team: { role: 'member', leadTaskId: 'task_lead', requestId: request.id },
    });
    const consolidation = repos.tasks
      .list('run_id = ?', 'run')
      .find((t) => t.team?.role === 'consolidate')!;
    expect(consolidation).toMatchObject({
      workerId: 'w_claude',
      parentTaskId: 'task_lead',
      team: { resume: 1 },
    });
    expect(consolidation.dependsOn).toEqual(['lead', work.key]);
    // QA waited for the leader's first session; now it waits for the team's result too.
    expect(get('task_qa').dependsOn).toEqual(['lead', consolidation.key]);

    const again = teams.delegate('task_lead', {
      key: 'implementar',
      agentId,
      title: 'x',
      description: 'y',
      acceptanceCriteria: [],
    });
    expect(again.id).toBe(request.id);
    expect(repos.tasks.list('run_id = ?', 'run')).toHaveLength(4);
    expect(repos.teamMessagesOf('run').map((m) => m.kind)).toEqual(['spawn', 'delegation']);
  });

  it('recusa delegar a quem não é da equipe ou depois de uma delegação desconhecida', () => {
    const { teams } = setup();
    const agentId = teams.spawnAgent('task_lead', codex).result.agentId!;
    expect(
      teams.delegate('task_lead', {
        key: 'a',
        agentId: 'w_qa',
        title: 't',
        description: 'd',
        acceptanceCriteria: ['ok'],
      }),
    ).toMatchObject({
      status: 'rejected',
      reason: expect.stringMatching(/Só membros/),
    });
    expect(
      teams.delegate('task_lead', {
        key: 'b',
        agentId,
        title: 't',
        description: 'd',
        acceptanceCriteria: ['ok'],
        after: ['nada'],
      }),
    ).toMatchObject({
      status: 'rejected',
      reason: expect.stringMatching(/desconhecida/),
    });
  });

  it('um pedido interrompido no meio é completado, não duplicado, quando repetido', () => {
    const { repos, teams, scheduler } = setup();
    const agentId = teams.spawnAgent('task_lead', codex).result.agentId!;
    const original = scheduler.setDependency.bind(scheduler);
    let fail = true;
    scheduler.setDependency = (...args: Parameters<typeof original>) => {
      if (fail) {
        fail = false;
        throw new Error('o aplicativo caiu aqui');
      }
      return original(...args);
    };
    const input = {
      key: 'impl',
      agentId,
      title: 'Implementar',
      description: 'd',
      acceptanceCriteria: ['ok'],
    };
    expect(() => teams.delegate('task_lead', input)).toThrow(/caiu/);
    expect(repos.teamRequests.list()).toHaveLength(1); // only the spawn: the delegation was not decided
    const done = teams.delegate('task_lead', input);
    expect(done.status).toBe('accepted');
    const members = repos.tasks.list('run_id = ?', 'run').filter((t) => t.team?.role === 'member');
    expect(members).toHaveLength(1);
    expect(members[0]!.id).toBe(done.result.taskId);
    const consolidation = repos.tasks
      .list('run_id = ?', 'run')
      .filter((t) => t.team?.role === 'consolidate');
    expect(consolidation).toHaveLength(1);
    expect(consolidation[0]!.dependsOn).toContain(members[0]!.key);
  });

  it('o líder retomado pode delegar de novo, até o limite de retomadas', () => {
    const { repos, teams, get } = setup();
    const settings = repos.getSettings();
    repos.saveSettings({ ...settings, teams: { ...settings.teams, maxLeaderResumes: 2 } });
    const agentId = teams.spawnAgent('task_lead', codex).result.agentId!;
    teams.delegate('task_lead', {
      key: 'v1',
      agentId,
      title: 'V1',
      description: 'd',
      acceptanceCriteria: ['ok'],
    });
    const first = repos.tasks.list('run_id = ?', 'run').find((t) => t.team?.resume === 1)!;
    // The leader is resumed (its consolidation runs) and asks for more.
    repos.tasks.put({ ...get('task_lead'), status: 'completed' });
    repos.tasks.put({ ...first, status: 'running' });
    expect(
      teams.delegate(first.id, {
        key: 'v2',
        agentId,
        title: 'V2',
        description: 'd',
        acceptanceCriteria: ['ok'],
      }).status,
    ).toBe('accepted');
    const second = repos.tasks.list('run_id = ?', 'run').find((t) => t.team?.resume === 2)!;
    expect(second.dependsOn).toContain(first.key);
    expect(get('task_qa').dependsOn).toContain(second.key);
    repos.tasks.put({ ...first, status: 'completed' });
    repos.tasks.put({ ...second, status: 'running' });
    expect(
      teams.delegate(second.id, {
        key: 'v3',
        agentId,
        title: 'V3',
        description: 'd',
        acceptanceCriteria: ['ok'],
      }),
    ).toMatchObject({
      status: 'rejected',
      reason: expect.stringMatching(/retomado 2 vezes/),
    });
  });
});

describe('Hive Teams: revisão e relatórios', () => {
  function reviewed() {
    const ctx = setup();
    const { teams, repos, get } = ctx;
    const author = teams.spawnAgent('task_lead', codex).result.agentId!;
    const reviewer = teams.spawnAgent('task_lead', nemotron).result.agentId!;
    const work = teams.delegate('task_lead', {
      key: 'impl',
      agentId: author,
      title: 'Implementar',
      description: 'd',
      acceptanceCriteria: ['ok'],
    });
    expect(
      teams.requestReview('task_lead', {
        key: 'rev',
        agentId: author,
        of: ['impl'],
        instructions: 'x',
      }),
    ).toMatchObject({
      status: 'rejected',
      reason: expect.stringMatching(/não pode revisá-lo/),
    });
    const review = teams.requestReview('task_lead', {
      key: 'revisar',
      agentId: reviewer,
      of: ['impl'],
      instructions: 'Confira o contrato e os testes.',
    });
    const reviewTask = get(review.result.taskId!);
    const workTask = get(work.result.taskId!);
    expect(reviewTask).toMatchObject({
      workerId: reviewer,
      dependsOn: ['lead', workTask.key],
      team: { role: 'review', reviewOf: [workTask.id] },
    });
    const consolidation = repos.tasks
      .list('run_id = ?', 'run')
      .find((t) => t.team?.role === 'consolidate')!;
    expect(consolidation.dependsOn).toEqual(['lead', workTask.key, reviewTask.key]);
    // The work is done and the review runs.
    repos.tasks.put({
      ...workTask,
      status: 'completed',
      startCommit: 'c0',
      result: {
        summary: 'feito',
        filesChanged: [],
        insertions: 1,
        deletions: 0,
        commit: 'c1',
        commands: [],
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    });
    repos.tasks.put({ ...reviewTask, status: 'running' });
    return { ...ctx, author, reviewer, workTask, reviewTask };
  }

  const changes = {
    verdict: 'changes_requested' as const,
    summary: 'Falta validar o título vazio.',
    comments: [
      {
        path: 'src/tasks.ts',
        line: 12,
        body: 'Rejeite título vazio com 400.',
        severity: 'major' as const,
      },
    ],
  };

  it('mudanças pedidas voltam ao autor pela revisão existente, como feedback rastreável', () => {
    const { teams, get, repos, workTask, reviewTask, author } = reviewed();
    const outcome = teams.submitReview(reviewTask.id, changes);
    expect(outcome.revised).toEqual([workTask.id]);
    const revised = get(workTask.id);
    expect(revised.status).toBe('pending');
    expect(revised.revision).toMatchObject({
      round: 1,
      fromCommit: 'c1',
      comments: [{ path: 'src/tasks.ts', line: 12, body: '[major] Rejeite título vazio com 400.' }],
    });
    const feedback = repos.teamMessagesOf('run').find((m) => m.kind === 'feedback')!;
    expect(feedback).toMatchObject({
      toAgentId: author,
      toTaskId: workTask.id,
      payload: { verdict: 'changes_requested', round: 0 },
    });
    expect(teams.inbox('run', author).map((m) => m.kind)).toEqual([
      'spawn',
      'delegation',
      'feedback',
    ]);
  });

  it('o mesmo veredito enviado de novo não manda o trabalho de volta outra vez', () => {
    const { teams, get, workTask, reviewTask, repos } = reviewed();
    teams.submitReview(reviewTask.id, changes);
    expect(teams.submitReview(reviewTask.id, changes).revised).toEqual([]);
    expect(get(workTask.id).revision?.round).toBe(1);
    expect(repos.teamMessagesOf('run').filter((m) => m.kind === 'feedback')).toHaveLength(1);
  });

  it('respeita o limite de rodadas de revisão', () => {
    const { teams, get, workTask, reviewTask, repos } = reviewed();
    const settings = repos.getSettings();
    repos.saveSettings({ ...settings, teams: { ...settings.teams, maxReviewRounds: 1 } });
    repos.tasks.put({
      ...get(workTask.id),
      revision: {
        fromCommit: 'c1',
        startCommit: 'c0',
        round: 1,
        previousSummary: '',
        comments: [],
        note: '',
      },
    });
    expect(teams.submitReview(reviewTask.id, changes).revised).toEqual([]);
    expect(get(workTask.id).status).toBe('completed');
  });

  it('aprovado não reabre nada; o resultado de cada membro chega ao líder uma vez', () => {
    const { teams, get, workTask, reviewTask, repos } = reviewed();
    expect(
      teams.submitReview(reviewTask.id, { verdict: 'approved', summary: 'Ok.', comments: [] })
        .revised,
    ).toEqual([]);
    expect(get(workTask.id).status).toBe('completed');
    teams.taskFinished(get(workTask.id));
    teams.taskFinished(get(workTask.id));
    const reports = teams.inbox('run', 'w_claude').filter((m) => m.kind === 'report');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      fromTaskId: workTask.id,
      body: 'feito',
      payload: { status: 'completed' },
    });
    expect(repos.teamMessagesOf('run').at(-1)!.kind).toBe('report');
  });

  it('o relatório do líder vai para a Queen, uma vez por sessão', () => {
    const { teams, repos } = setup();
    teams.report('task_lead', { summary: 'API pronta e revisada.' });
    teams.report('task_lead', { summary: 'API pronta e revisada.' });
    const reports = repos.teamMessagesOf('run').filter((m) => m.kind === 'report');
    expect(reports).toEqual([
      expect.objectContaining({
        fromAgentId: 'w_claude',
        toAgentId: null,
        body: 'API pronta e revisada.',
      }),
    ]);
  });
});

describe('Hive Teams: escolha de modelo com um catálogo como o real', () => {
  it('Codex pelo plano ChatGPT mesmo sem "codex" no nome; Claude por um gateway como o Kilo', () => {
    const providers = [
      provider('chatgpt', 'chatgpt'),
      provider('kilo', 'kilo'),
      provider('nvidia', 'nvidia'),
    ];
    const catalogs: Record<string, ModelInfo[]> = {
      chatgpt: ['gpt-5.6-luna', 'gpt-6-sol', 'gpt-6.1-sol'].map((id) => model('chatgpt', id)),
      kilo: ['anthropic/claude-sonnet-5.5', 'openai/gpt-5.3-codex'].map((id) => model('kilo', id)),
      nvidia: [model('nvidia', 'nvidia/nemotron-3-ultra-550b-a55b')],
    };
    const choose = (profile: Parameters<typeof chooseTeamModel>[0]) =>
      chooseTeamModel(profile, providers, (id) => catalogs[id] ?? [], 'backend');
    // The official ChatGPT sign-in comes first, with the model Hive picks for code on that plan.
    expect(choose({ family: 'codex' })).toMatchObject({ ok: true, providerId: 'chatgpt' });
    expect((choose({ family: 'codex' }) as { modelId: string }).modelId).toMatch(/^gpt-6/);
    // Asked by exact model, the paid gateway model is used.
    expect(choose({ family: 'codex', model: 'openai/gpt-5.3-codex' })).toEqual({
      ok: true,
      providerId: 'kilo',
      modelId: 'openai/gpt-5.3-codex',
    });
    expect(choose({ family: 'claude' })).toEqual({
      ok: true,
      providerId: 'kilo',
      modelId: 'anthropic/claude-sonnet-5.5',
    });
    expect(choose({ family: 'nemotron' })).toEqual({
      ok: true,
      providerId: 'nvidia',
      modelId: 'nvidia/nemotron-3-ultra-550b-a55b',
    });
  });
});
