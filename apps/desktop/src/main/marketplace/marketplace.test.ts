import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultLimits, specialistRoles, type SkillSummary, type Worker } from '@hive/core';
import { HiveDatabase, Repositories } from '@hive/persistence';
import { Marketplace } from './marketplace';
import { BuiltinRegistry, RemoteRegistry, sha256, type MarketplaceRegistry } from './registry';

vi.mock('electron', () => ({}));

const databases: HiveDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** A Hive installation: its own database, skill library and the files the user saves. */
function hive(registries: () => MarketplaceRegistry[] = () => [new BuiltinRegistry()]) {
  const db = new HiveDatabase(':memory:');
  databases.push(db);
  const repos = new Repositories(db);
  const library = new Map<string, string>();
  const saved: { name: string; content: string }[] = [];
  let toOpen: string | null = null;
  const marketplace = new Marketplace({
    repos,
    hiveVersion: () => '0.2.6',
    registries,
    skills: {
      list: async () =>
        [...library.keys()].map(
          (name) => ({ name, source: 'local', builtin: false, hasScripts: false }) as SkillSummary,
        ),
      save: async (raw) => {
        const name = /name: ([\w-]+)/.exec(raw)![1]!;
        library.set(name, raw);
      },
      raw: async (name) => library.get(name) ?? null,
    },
    connectWorker: () => undefined,
    onChange: () => undefined,
    save: async (name, content) => {
      saved.push({ name, content });
      return `C:/pacotes/${name}`;
    },
    open: async () => toOpen,
  });
  const offer = (text: string) => {
    toOpen = text;
  };
  return { repos, marketplace, library, saved, offer };
}

const worker = (overrides: Partial<Worker>): Worker => ({
  id: 'w_mine',
  name: 'Minha QA',
  role: 'qa',
  beeColor: null,
  squad: [],
  description: 'Testa telas',
  providerId: 'p_meu',
  modelId: 'modelo-pago',
  skills: [],
  tools: ['read_file', 'run_command'],
  mcpServers: ['mcp_privado'],
  autoApproveCommands: ['npm test'],
  systemPrompt: 'Teste tudo com cuidado.',
  limits: defaultLimits,
  createdAt: '2026-11-24T10:00:00.000Z',
  updatedAt: '2026-11-24T10:00:00.000Z',
  ...overrides,
});

describe('catálogo do Hive', () => {
  it('todos os pacotes embutidos são válidos, instaláveis e conferem com o hash do índice', async () => {
    const { marketplace } = hive();
    const catalog = await marketplace.catalog();
    expect(catalog.rejected).toEqual([]);
    expect(catalog.listings.map((item) => item.package.id).sort()).toEqual([
      'analista-de-requisitos',
      'detetive-de-bugs',
      'dev-de-interface',
      'engenheiro-de-banco-de-dados',
      'engenheiro-de-integracao',
      'engenheiro-de-performance',
      'engenheiro-de-seguranca',
      'esquadrao-web',
      'explorador-de-codigo',
      'qa-de-interface',
      'qa-web',
      'revisor-de-acessibilidade',
    ]);
    expect(catalog.listings.every((item) => item.installable)).toBe(true);
  });

  it('cada especialista que saiu do Hive tem o seu pacote, e cada agente de equipe vende sozinho', async () => {
    const { listings } = await hive().marketplace.catalog();
    const single = listings.filter((item) => item.package.category === 'agent');
    for (const role of specialistRoles)
      expect(single.some((item) => item.package.agents[0]!.role === role)).toBe(true);
    const teams = listings.filter((item) => item.package.category === 'team');
    for (const team of teams)
      for (const agent of team.package.agents)
        expect(single.some((item) => item.package.agents[0]!.name === agent.name)).toBe(true);
  });
});

describe('pacotes recusados', () => {
  const base = async () =>
    JSON.parse(await new BuiltinRegistry().read('packages/qa-de-interface.json')) as Record<
      string,
      unknown
    >;
  const problem = (text: string) => hive().marketplace.check(text).problem;

  it('campos que executam ou são pessoais, chaves escondidas e pacotes alterados', async () => {
    const pkg = await base();
    const agents = pkg.agents as Record<string, unknown>[];
    expect(
      problem(
        JSON.stringify({ ...pkg, agents: [{ ...agents[0], autoApproveCommands: ['rm -rf /'] }] }),
      ),
    ).toContain('campos que um pacote não pode ter (autoApproveCommands');
    expect(problem(JSON.stringify({ ...pkg, mcpServers: ['x'] }))).toContain('mcpServers');
    expect(problem(JSON.stringify({ ...pkg, apiKey: 'x' }))).toContain('apiKey');
    expect(
      problem(JSON.stringify({ ...pkg, description: `use a chave sk-proj-${'a'.repeat(40)}` })),
    ).toContain('formato de chave');
    const raw = JSON.stringify(pkg);
    expect(hive().marketplace.check(raw, sha256(`${raw} `)).problem).toContain('foi alterado');
  });

  it('incompatível, categoria ainda não instalável e ferramenta não declarada', async () => {
    const pkg = await base();
    expect(problem(JSON.stringify({ ...pkg, minHiveVersion: '9.0.0' }))).toContain(
      'Precisa do Hive 9.0.0',
    );
    expect(problem(JSON.stringify({ ...pkg, category: 'workflow' }))).toContain(
      'instala só agentes, equipes e skills',
    );
    expect(problem(JSON.stringify({ ...pkg, permissions: ['read_file'] }))).toContain(
      'não está em permissions',
    );
    expect(problem('{ isto não é json')).toContain('JSON');
  });

  it('o catálogo da comunidade só aceita https e o índice não aponta para fora dele', async () => {
    expect(() => new RemoteRegistry('http://exemplo.com/catalogo')).toThrow('https');
    const index = {
      schemaVersion: 1,
      packages: [{ id: 'x', version: '1.0.0', path: '../segredo.json', sha256: 'a'.repeat(64) }],
    };
    const remote = new RemoteRegistry(
      'https://exemplo.com/catalogo',
      (async () => new Response(JSON.stringify(index))) as typeof fetch,
    );
    const catalog = await hive(() => [remote]).marketplace.catalog();
    expect(catalog.rejected[0]!.problem).toContain('Caminho fora do catálogo');
  });
});

describe('instalar, exportar e importar', () => {
  it('instala um agente sem nada pessoal, com a skill do pacote, e não instala duas vezes', async () => {
    const { marketplace, repos, library } = hive();
    const preview = await marketplace.preview('Hive', 'qa-de-interface');
    expect(preview.permissions.find((item) => item.tool === 'run_command')).toMatchObject({
      sensitive: true,
    });
    expect(preview.newSkills).toEqual(['teste-no-hive-browser']);
    const installed = await marketplace.install('Hive', 'qa-de-interface');
    const agent = repos.workers.require(installed.workers['qa-interface']!, 'Agente');
    expect(agent).toMatchObject({
      name: 'QA de Interface',
      role: 'qa',
      providerId: null,
      modelId: null,
      autoApproveCommands: [],
      mcpServers: [],
      skills: ['teste-no-hive-browser'],
    });
    expect(library.has('teste-no-hive-browser')).toBe(true);
    await expect(marketplace.install('Hive', 'qa-de-interface')).rejects.toThrow(
      'já está instalado',
    );
  });

  it('exporta um agente sem credenciais e ele instala em outra instalação do Hive', async () => {
    const mine = hive();
    mine.repos.workers.put(worker({}));
    const file = await mine.marketplace.export({
      workerIds: ['w_mine'],
      id: 'minha-qa',
      name: 'Minha QA',
      description: 'A QA que eu uso.',
      author: 'Eu',
      version: '1.0.0',
      license: 'MIT',
      tags: ['qa'],
      includeSkills: false,
    });
    expect(file).toBe('C:/pacotes/minha-qa-1.0.0.json');
    const text = mine.saved[0]!.content;
    for (const personal of ['p_meu', 'modelo-pago', 'mcp_privado', 'npm test', 'w_mine'])
      expect(text).not.toContain(personal);
    // Another Hive opens the file: checked first, installed only on the second step.
    const other = hive();
    other.offer(text);
    const opened = await other.marketplace.importFile();
    expect(opened!.preview.listing.package.agents[0]!.name).toBe('Minha QA');
    expect(other.repos.workers.list().some((item) => item.name === 'Minha QA')).toBe(false);
    const installed = await other.marketplace.installImported(opened!.token);
    const copy = other.repos.workers.require(Object.values(installed.workers)[0]!, 'Agente');
    expect(copy).toMatchObject({
      systemPrompt: 'Teste tudo com cuidado.',
      providerId: null,
      autoApproveCommands: [],
    });
  });

  it('instruções com algo em formato de chave não são exportadas', async () => {
    const mine = hive();
    mine.repos.workers.put(worker({ systemPrompt: `Use ghp_${'x'.repeat(36)} para o GitHub.` }));
    await expect(
      mine.marketplace.export({
        workerIds: ['w_mine'],
        id: 'vaza',
        name: 'Vaza',
        description: 'x',
        author: 'Eu',
        version: '1.0.0',
        license: 'MIT',
        tags: [],
        includeSkills: false,
      }),
    ).rejects.toThrow('formato de chave');
    expect(mine.saved).toEqual([]);
  });
});

describe('atualizar, voltar e desinstalar', () => {
  /** A community source whose package can be swapped for a newer version. */
  function source(initial: string) {
    let text = initial;
    const registry: MarketplaceRegistry = {
      id: 'comunidade',
      label: 'Comunidade',
      index: async () => {
        const pkg = JSON.parse(text) as { id: string; version: string };
        return {
          schemaVersion: 1,
          packages: [
            { id: pkg.id, version: pkg.version, path: 'packages/p.json', sha256: sha256(text) },
          ],
        };
      },
      read: async () => text,
    };
    return { registry, publish: (next: string) => (text = next) };
  }

  it('a atualização mantém o que o usuário personalizou e dá para voltar', async () => {
    const v1 = JSON.parse(
      await new BuiltinRegistry().read('packages/revisor-de-acessibilidade.json'),
    );
    const { registry, publish } = source(JSON.stringify(v1));
    const { marketplace, repos } = hive(() => [registry]);
    const installed = await marketplace.install('Comunidade', 'revisor-de-acessibilidade');
    const id = installed.workers['revisor-a11y']!;
    // The user renames the agent; the instructions stay as installed.
    repos.workers.put({ ...repos.workers.require(id, 'Agente'), name: 'Meu revisor' });
    const v2 = structuredClone(v1);
    v2.version = '1.1.0';
    v2.agents[0].name = 'Revisor A11y';
    v2.agents[0].instructions = 'Instruções novas.';
    publish(JSON.stringify(v2));
    expect((await marketplace.catalog(true)).listings[0]!.updateAvailable).toBe(true);
    const updated = await marketplace.update('revisor-de-acessibilidade');
    const after = repos.workers.require(id, 'Agente');
    expect(after.name).toBe('Meu revisor');
    expect(after.systemPrompt).toBe('Instruções novas.');
    expect(updated.kept).toEqual(['Meu revisor: name']);
    expect(updated.installed.version).toBe('1.1.0');
    const back = await marketplace.restore('revisor-de-acessibilidade');
    expect(back.installed.version).toBe('1.0.0');
    expect(repos.workers.require(id, 'Agente').systemPrompt).toBe(v1.agents[0].instructions);
    expect(repos.workers.require(id, 'Agente').name).toBe('Meu revisor');
  });

  it('não desinstala enquanto um agente do pacote trabalha', async () => {
    const { marketplace, repos } = hive();
    const installed = await marketplace.install('Hive', 'esquadrao-web');
    const workerId = installed.workers['qa-web']!;
    repos.tasks.put({
      id: 't1',
      runId: 'r1',
      key: 't1',
      title: 'Testar',
      description: 'd',
      workerId,
      dependsOn: [],
      acceptanceCriteria: ['ok'],
      status: 'running',
      workerState: 'thinking',
      attempt: 1,
      branch: null,
      startCommit: null,
      worktreePath: null,
      result: null,
      error: null,
      createdAt: '2026-11-24T10:00:00.000Z',
      startedAt: null,
      finishedAt: null,
    });
    expect(() => marketplace.uninstall('esquadrao-web')).toThrow('trabalhando agora');
    repos.tasks.put({ ...repos.tasks.require('t1', 'Tarefa'), status: 'completed' });
    marketplace.uninstall('esquadrao-web');
    expect(repos.workers.get(workerId)).toBeNull();
    expect(marketplace.installed()).toEqual([]);
  });
});
