import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HiveDatabase } from '@hive/persistence';
import type {
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
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.unstubAllGlobals();
  mocks.selected = '';
  mocks.encrypted = true;
});
function setup(file = ':memory:') {
  const db = new HiveDatabase(file);
  databases.push(db);
  const pushes: HivePush[] = [];
  return { service: new DesktopService(db, os.tmpdir(), (push) => pushes.push(push)), db, pushes };
}

describe('desktop integrado aos serviços locais', () => {
  it('persiste os agentes iniciais sem duplicar ao reabrir o banco', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'hive-service-'));
    const file = path.join(folder, 'test.sqlite');
    const first = setup(file);
    const workers = (await first.service.invoke('worker.list', undefined)) as Worker[];
    expect(workers).toHaveLength(6);
    const worker = workers[0]!;
    await first.service.invoke('worker.save', { ...worker, name: 'Minha equipe' });
    first.db.close();
    databases.splice(databases.indexOf(first.db), 1);
    const second = setup(file);
    const reopened = (await second.service.invoke('worker.list', undefined)) as Worker[];
    expect(reopened).toHaveLength(6);
    expect(reopened.find((item) => item.id === worker.id)?.name).toBe('Minha equipe');
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
