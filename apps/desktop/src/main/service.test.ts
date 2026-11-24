import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HiveDatabase, Repositories } from '@hive/persistence';
import { rolePresets, specialistRoles } from '@hive/core';
import type {
  AutopilotStatus,
  HivePush,
  CodeAssistantResponse,
  MissionDetail,
  ProviderConfig,
  RecommendedSetup,
  RunDetail,
  Worker,
  Workspace,
  WorkspacePick,
} from '@hive/core';

const mocks = vi.hoisted(() => ({ selected: '', encrypted: true }));
vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.0' },
  shell: { openExternal: vi.fn() },
  dialog: {
    showOpenDialog: async () => ({
      canceled: !mocks.selected,
      filePaths: mocks.selected ? [mocks.selected] : [],
    }),
  },
  safeStorage: {
    isEncryptionAvailable: () => mocks.encrypted,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().replace('encrypted:', ''),
  },
}));
import { DesktopService } from './service';

const databases: HiveDatabase[] = [];
const services: DesktopService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  for (const db of databases.splice(0)) db.close();
  vi.unstubAllGlobals();
  mocks.selected = '';
  mocks.encrypted = true;
});
function setup(file = ':memory:') {
  const db = new HiveDatabase(file);
  databases.push(db);
  const pushes: HivePush[] = [];
  const service = new DesktopService(db, os.tmpdir(), (push) => pushes.push(push));
  services.push(service);
  return { service, db, pushes };
}

// Several tests here create real git repositories; like the Scheduler's, they get time to spare.
describe('desktop integrado aos serviços locais', { timeout: 30_000 }, () => {
  it('persiste os agentes iniciais sem duplicar ao reabrir o banco', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'hive-service-'));
    const file = path.join(folder, 'test.sqlite');
    const first = setup(file);
    const workers = (await first.service.invoke('worker.list', undefined)) as Worker[];
    // The six agents of the first version and the seven specialists.
    expect(workers).toHaveLength(13);
    const worker = workers[0]!;
    await first.service.invoke('worker.save', { ...worker, name: 'Minha equipe' });
    first.service.dispose();
    services.splice(services.indexOf(first.service), 1);
    first.db.close();
    databases.splice(databases.indexOf(first.db), 1);
    const second = setup(file);
    const reopened = (await second.service.invoke('worker.list', undefined)) as Worker[];
    expect(reopened).toHaveLength(13);
    expect(reopened.find((item) => item.id === worker.id)?.name).toBe('Minha equipe');
  });

  it('uma instalação antiga recebe os especialistas uma vez; apagado não volta, e nada duplica', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'hive-service-'));
    const file = path.join(folder, 'test.sqlite');
    const reopen = async (prepare?: (repos: Repositories) => void) => {
      const { service, db } = setup(file);
      const workers = (await service.invoke('worker.list', undefined)) as Worker[];
      prepare?.(new Repositories(db));
      service.dispose();
      services.splice(services.indexOf(service), 1);
      db.close();
      databases.splice(databases.indexOf(db), 1);
      return workers;
    };
    // As an install from before the specialists: six agents, one renamed and given a model.
    await reopen((repos) => {
      for (const worker of repos.workers.list())
        if (specialistRoles.includes(worker.role)) repos.workers.delete(worker.id);
      const backend = repos.workers.list().find((worker) => worker.role === 'backend')!;
      repos.workers.put({ ...backend, name: 'Meu backend', providerId: null, modelId: 'x' });
      // The user already made a security agent of their own.
      repos.workers.put({ ...backend, id: 'w_sec', name: 'Segurança da casa', role: 'security' });
      repos.setValue('specialistsInstalled', '');
    });
    const upgraded = await reopen((repos) => {
      repos.workers.delete(repos.workers.list().find((worker) => worker.role === 'debugger')!.id);
    });
    // Six of the seven came: the user's own security agent stands for the seventh.
    expect(upgraded.filter((worker) => specialistRoles.includes(worker.role))).toHaveLength(7);
    expect(upgraded.filter((worker) => worker.role === 'security')).toHaveLength(1);
    const backend = upgraded.find((worker) => worker.role === 'backend')!;
    expect(backend.name).toBe('Meu backend');
    expect(backend.modelId).toBe('x');
    const explorer = upgraded.find((worker) => worker.role === 'explorer')!;
    expect(explorer).toEqual(
      expect.objectContaining({
        name: 'Codebase Explorer',
        providerId: null,
        modelId: null,
        tools: rolePresets.explorer.tools,
        skills: rolePresets.explorer.skills,
      }),
    );
    // The Debug Detective the user deleted does not come back.
    const after = await reopen();
    expect(after.some((worker) => worker.role === 'debugger')).toBe(false);
    expect(after).toHaveLength(upgraded.length - 1);
  });

  it('cria missão de um repositório real, consulta API simulada e persiste o plano', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'hive-repo-'));
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true });
    git(['init', '-b', 'main']);
    await writeFile(path.join(repo, 'README.md'), '# Teste\n');
    git(['add', 'README.md']);
    git([
      '-c',
      'user.name=Hive Test',
      '-c',
      'user.email=test@hive.local',
      '-c',
      'core.hooksPath=',
      'commit',
      '-m',
      'initial',
    ]);
    mocks.selected = repo;
    const { service, pushes } = setup();
    const picked = (await service.invoke('workspace.pick', undefined)) as WorkspacePick;
    if (picked?.status !== 'opened') throw new Error('A pasta de teste devia abrir direto.');
    const workspace = picked.workspace;
    expect(workspace.path.toLowerCase()).toBe(repo.toLowerCase());
    const provider = (await service.invoke('provider.save', {
      kind: 'openai-compatible',
      name: 'Local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      enabled: true,
    })) as ProviderConfig;
    const workers = (await service.invoke('worker.list', undefined)) as Worker[];
    const queen = workers.find((worker) => worker.role === 'queen')!;
    await service.invoke('worker.save', {
      ...queen,
      providerId: provider.id,
      modelId: 'test-model',
    });
    const created = (await service.invoke('mission.create', {
      title: 'Implementar teste',
      objective: 'Criar uma mudança verificável.',
    })) as MissionDetail & { runId: string };
    const fakeFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    notes: 'Plano verificado',
                    tasks: [
                      {
                        key: 'test',
                        title: 'Escrever teste',
                        description: 'Adicionar teste focado',
                        workerId: null,
                        dependsOn: [],
                        acceptanceCriteria: ['Teste passa'],
                      },
                    ],
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 20 },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fakeFetch);
    const planned = (await service.invoke('run.plan', {
      runId: created.runId,
      queenWorkerId: queen.id,
    })) as RunDetail;
    expect(planned.run.status).toBe('awaiting_plan_approval');
    expect(planned.tasks[0]?.acceptanceCriteria).toEqual(['Teste passa']);
    expect(((await service.invoke('run.get', created.runId)) as RunDetail).tasks).toHaveLength(1);
    expect(fakeFetch).toHaveBeenCalledOnce();
    expect(pushes.some((push) => push.kind === 'changed' && push.entity === 'run')).toBe(true);
    expect(await readFile(path.join(repo, 'README.md'), 'utf8')).toBe('# Teste\n');
    expect(git(['status', '--porcelain']).toString()).toBe('');
  });

  it('projeto do zero: a verificação usa o comando do plano e só nas tarefas finais', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'hive-zero-'));
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true });
    git(['init', '-b', 'main']);
    await writeFile(path.join(repo, 'README.md'), '# Do zero\n');
    git(['add', 'README.md']);
    git([
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@hive.local',
      '-c',
      'core.hooksPath=',
      'commit',
      '-m',
      'i',
    ]);
    mocks.selected = repo;
    const { service } = setup();
    await service.invoke('workspace.pick', undefined);
    const provider = (await service.invoke('provider.save', {
      kind: 'openai-compatible',
      name: 'Local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      enabled: true,
    })) as ProviderConfig;
    const workers = (await service.invoke('worker.list', undefined)) as Worker[];
    const pick = (role: string) => workers.find((worker) => worker.role === role)!;
    const [queen, backend, frontend] = [pick('queen'), pick('backend'), pick('frontend')];
    for (const worker of [queen, backend, frontend])
      await service.invoke('worker.save', { ...worker, providerId: provider.id, modelId: 'm' });
    const created = (await service.invoke('mission.create', {
      title: 'App do zero',
      objective: 'Criar um app desktop.',
    })) as MissionDetail & { runId: string };
    const task = (key: string, workerId: string, dependsOn: string[]) => ({
      key,
      title: key,
      description: key,
      workerId,
      dependsOn,
      acceptanceCriteria: ['ok'],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      notes: 'Contrato primeiro, depois a interface, depois a integração.',
                      tasks: [
                        { ...task('contract', backend.id, []), covers: ['R1'] },
                        task('ui', frontend.id, ['contract']),
                        task('integrate', backend.id, ['ui']),
                      ],
                      verify: ['rm -rf /', 'npm run build', 'npm test'],
                      requirements: [
                        { id: 'R1', text: 'Canais IPC tipados' },
                        { id: 'R2', text: 'README com instalação' },
                      ],
                    }),
                  },
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 20 },
            }),
            { status: 200 },
          ),
      ),
    );
    await service.invoke('run.plan', { runId: created.runId, queenWorkerId: queen.id });
    type Layout = {
      flow: { id: string; kind: string; command?: string; retries?: number }[];
      links: { source: string; target: string; port: string }[];
      notes: { text: string }[];
      dialogues: { id: string }[];
      deliveries: { id: string }[];
    };
    let layout: Layout | null = null;
    for (let i = 0; i < 100 && !layout?.flow.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      layout = (await service.invoke('canvas.layout.get', created.runId)) as Layout;
    }
    const check = layout!.flow.find((block) => block.kind === 'check')!;
    const approval = layout!.flow.find((block) => block.kind === 'approval')!;
    // The dangerous command is refused; the first allowed one is used.
    expect(check.command).toBe('npm run build');
    expect(check.retries).toBe(2);
    const from = (source: string) =>
      layout!.links.filter((link) => link.source === source).map((link) => link.target);
    // The agent of the final task is checked; the other goes straight to approval.
    expect(from(`agent:${backend.id}`)).toEqual([check.id]);
    expect(from(`agent:${frontend.id}`)).toEqual([approval.id]);
    expect(layout!.links).toContainEqual(
      expect.objectContaining({ source: check.id, target: `agent:${backend.id}`, port: 'fail' }),
    );
    expect(layout!.flow.some((block) => block.kind === 'notify')).toBe(true);
    const note = layout!.notes.find((item) => item.text.startsWith('Plano da Queen'))!;
    expect(note.text).toContain('Contrato primeiro');
    expect(note.text).toContain('npm run build · npm test');
    expect(note.text).not.toContain('rm -rf');
    // The team's conversation is on the canvas from the start.
    expect(layout!.dialogues).toHaveLength(1);
    expect(layout!.deliveries).toHaveLength(1);
    // The requirements reach the screen, and each agent reads the ones its task delivers.
    const detail = (await service.invoke('run.get', created.runId)) as RunDetail;
    expect(detail.requirements?.map((item) => item.id)).toEqual(['R1', 'R2']);
    const contract = detail.tasks.find((item) => item.key === 'contract')!;
    expect(contract.covers).toEqual(['R1']);
    expect(contract.description).toContain('R1: Canais IPC tipados');
    expect(contract.description).not.toContain('R2');
    expect(detail.delivery).toBeNull();
  });

  it('sem um repositório Git usável, nem planeja nem executa, e diz o que fazer', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'hive-semgit-'));
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true });
    git(['init', '-b', 'main']);
    await writeFile(path.join(repo, 'README.md'), '# Sem git\n');
    git(['add', 'README.md']);
    git([
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@hive.local',
      '-c',
      'core.hooksPath=',
      'commit',
      '-m',
      'i',
    ]);
    mocks.selected = repo;
    const { service } = setup();
    await service.invoke('workspace.pick', undefined);
    const provider = (await service.invoke('provider.save', {
      kind: 'openai-compatible',
      name: 'Local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      enabled: true,
    })) as ProviderConfig;
    const queen = ((await service.invoke('worker.list', undefined)) as Worker[]).find(
      (worker) => worker.role === 'queen',
    )!;
    await service.invoke('worker.save', { ...queen, providerId: provider.id, modelId: 'm' });
    const created = (await service.invoke('mission.create', {
      title: 'Sem Git',
      objective: 'Qualquer coisa.',
    })) as MissionDetail & { runId: string };
    // The project stops being a repository after it was opened.
    await rm(path.join(repo, '.git'), { recursive: true, force: true });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      service.invoke('run.plan', { runId: created.runId, queenWorkerId: queen.id }),
    ).rejects.toThrow('não é um repositório Git');
    await expect(service.invoke('run.start', created.runId)).rejects.toThrow(
      'não é um repositório Git',
    );
    // Nothing was spent and the mission is left as it was, ready once Git works.
    expect(fetch).not.toHaveBeenCalled();
    expect(((await service.invoke('run.get', created.runId)) as RunDetail).run.status).toBe(
      'draft',
    );
  });

  it('no Modo Turno, planeja a missão da fila sozinho e registra por que não pôde executar', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'hive-shift-'));
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true });
    git(['init', '-b', 'main']);
    await writeFile(path.join(repo, 'README.md'), '# Turno\n');
    git(['add', 'README.md']);
    git([
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@hive.local',
      '-c',
      'core.hooksPath=',
      'commit',
      '-m',
      'i',
    ]);
    mocks.selected = repo;
    const { service } = setup();
    await service.invoke('workspace.pick', undefined);
    const provider = (await service.invoke('provider.save', {
      kind: 'openai-compatible',
      name: 'Local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      enabled: true,
    })) as ProviderConfig;
    // Only the Queen has a model, so planning works and starting must fail with a clear reason.
    const queen = ((await service.invoke('worker.list', undefined)) as Worker[]).find(
      (worker) => worker.role === 'queen',
    )!;
    await service.invoke('worker.save', { ...queen, providerId: provider.id, modelId: 'm' });
    const plan = {
      notes: 'ok',
      tasks: [
        {
          key: 'a',
          title: 'Tarefa',
          description: 'd',
          workerId: null,
          dependsOn: [],
          acceptanceCriteria: ['ok'],
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify(plan) } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
            { status: 200 },
          ),
      ),
    );
    const created = (await service.invoke('mission.create', {
      title: 'Missão do turno',
      objective: 'Fazer algo.',
    })) as MissionDetail & { runId: string };
    await service.invoke('autopilot.setEnabled', true);
    await service.invoke('autopilot.enqueue', created.runId);

    const status = async () =>
      (await service.invoke('autopilot.status', undefined)) as AutopilotStatus;
    const started = Date.now();
    while ((await status()).history.length === 0) {
      if (Date.now() - started > 10_000) throw new Error('O turno não terminou a missão.');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const done = await status();
    expect(done.queue).toEqual([]);
    expect(done.history[0]).toMatchObject({ runId: created.runId, status: 'failed' });
    expect(done.history[0]?.error).toContain('Configure os agentes');
    expect(((await service.invoke('run.get', created.runId)) as RunDetail).tasks).toHaveLength(1);
  });

  it('oferece iniciar uma pasta comum como repositório, com commit inicial dos arquivos', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'hive-plain-'));
    await writeFile(path.join(folder, 'index.html'), '<h1>Oi</h1>');
    // Temp folders can sit inside another repository; stop Git from looking above this folder.
    vi.stubEnv('GIT_CEILING_DIRECTORIES', path.dirname(folder));
    mocks.selected = folder;
    const { service } = setup();
    const picked = (await service.invoke('workspace.pick', undefined)) as WorkspacePick;
    expect(picked).toMatchObject({ status: 'needs-init', path: folder });
    const workspace = (await service.invoke('workspace.initialize', { path: folder })) as Workspace;
    expect(workspace.path.toLowerCase()).toBe(folder.toLowerCase());
    const log = execFileSync('git', ['log', '--format=%s'], { cwd: folder, windowsHide: true });
    expect(log.toString().trim()).toBe('Projeto iniciado no Hive');
    const tracked = execFileSync('git', ['ls-files'], { cwd: folder, windowsHide: true });
    expect(tracked.toString()).toContain('index.html');
  });

  it('usa o agente configurado para propor uma edição sem alterar o arquivo', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'hive-code-ai-'));
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true });
    git(['init', '-b', 'main']);
    const source = 'const value = 1;\n';
    await writeFile(path.join(repo, 'app.ts'), source);
    mocks.selected = repo;
    const { service } = setup();
    await service.invoke('workspace.pick', undefined);
    const provider = (await service.invoke('provider.save', {
      kind: 'openai-compatible',
      name: 'Local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      enabled: true,
    })) as ProviderConfig;
    const workers = (await service.invoke('worker.list', undefined)) as Worker[];
    const reviewer = workers.find((worker) => worker.role === 'reviewer')!;
    await service.invoke('worker.save', {
      ...reviewer,
      providerId: provider.id,
      modelId: 'code-model',
    });
    const fakeFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    answer: 'Renomeei a variável.',
                    replacement: 'total',
                    summary: 'Renomear value para total',
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 8 },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fakeFetch);

    const result = (await service.invoke('code.assist', {
      workerId: reviewer.id,
      mode: 'edit',
      path: 'app.ts',
      fileContent: source,
      selection: { startOffset: 6, endOffset: 11, text: 'value' },
      instruction: 'Use um nome que indique o total.',
      history: [],
    })) as CodeAssistantResponse;

    expect(result.proposal).toEqual({
      replacement: 'total',
      summary: 'Renomear value para total',
    });
    expect(result.worker).toMatchObject({ id: reviewer.id, modelId: 'code-model' });
    expect(await readFile(path.join(repo, 'app.ts'), 'utf8')).toBe(source);
    expect(fakeFetch).toHaveBeenCalledOnce();
  });

  it('recusa salvar chave quando o armazenamento seguro não está disponível', async () => {
    const { service } = setup();
    const provider = (await service.invoke('provider.save', {
      kind: 'openai-compatible',
      name: 'Local',
      baseUrl: 'http://localhost:11434/v1',
      enabled: true,
    })) as ProviderConfig;
    mocks.encrypted = false;
    await expect(
      service.invoke('provider.setKey', { providerId: provider.id, key: 'test-secret-key' }),
    ).rejects.toThrow('armazenamento seguro');
    expect(service.repos.getSecret(provider.id)).toBeNull();
  });

  it('exige um workspace antes de criar uma missão', async () => {
    const { service } = setup();
    await expect(
      service.invoke('mission.create', { title: 'Teste', objective: 'Teste' }),
    ).rejects.toThrow('Selecione um repositório');
  });

  it('aplica a configuração recomendada pulando modelos listados que retornam 404', async () => {
    const { service } = setup();
    const provider = (await service.invoke('provider.save', {
      kind: 'nvidia',
      name: 'NVIDIA',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      enabled: true,
    })) as ProviderConfig;
    await service.invoke('provider.setKey', { providerId: provider.id, key: 'nvapi-test-key' });
    const retired = 'moonshotai/kimi-k2.6';
    const fakeFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/models'))
        return new Response(
          JSON.stringify({
            data: [retired, 'z-ai/glm-5.3', 'deepseek-ai/deepseek-v4.1-flash'].map((id) => ({
              id,
            })),
          }),
          { status: 200 },
        );
      const { model } = JSON.parse(String(init?.body)) as { model: string };
      if (model === retired)
        return new Response(JSON.stringify({ detail: 'Function not found for account' }), {
          status: 404,
        });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fakeFetch);
    const result = (await service.invoke('worker.applyRecommended', {
      providerId: provider.id,
    })) as RecommendedSetup;
    expect(result.assignments.every((item) => item.modelId)).toBe(true);
    expect(result.unavailable.map((item) => item.modelId)).toEqual([retired]);
    const workers = (await service.invoke('worker.list', undefined)) as Worker[];
    const byRole = Object.fromEntries(workers.map((worker) => [worker.role, worker.modelId]));
    expect(byRole.queen).toBe('z-ai/glm-5.3');
    expect(byRole.reviewer).toBe('deepseek-ai/deepseek-v4.1-flash');
    expect(workers.every((worker) => worker.providerId === provider.id)).toBe(true);
    // models list + one test call per distinct candidate
    expect(fakeFetch).toHaveBeenCalledTimes(4);
  });

  it('remover um provedor desvincula os agentes que o usavam', async () => {
    const { service } = setup();
    const provider = (await service.invoke('provider.save', {
      kind: 'openai-compatible',
      name: 'Local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      enabled: true,
    })) as ProviderConfig;
    const [worker] = (await service.invoke('worker.list', undefined)) as Worker[];
    await service.invoke('worker.save', { ...worker!, providerId: provider.id, modelId: 'm' });
    await service.invoke('provider.delete', provider.id);
    const after = (await service.invoke('worker.list', undefined)) as Worker[];
    const detached = after.find((item) => item.id === worker!.id)!;
    expect([detached.providerId, detached.modelId]).toEqual([null, null]);
  });
});
