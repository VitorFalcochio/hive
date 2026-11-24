import {
  compareVersions,
  defaultLimits,
  installableCategories,
  marketplacePackageSchema,
  toolDescriptions,
  type MarketplaceAgent,
  type MarketplaceCatalog,
  type MarketplaceExport,
  type MarketplaceInstalled,
  type MarketplaceListing,
  type MarketplacePackage,
  type MarketplacePreview,
  type SkillSummary,
  type ToolName,
  type Worker,
} from '@hive/core';
import type { Repositories } from '@hive/persistence';
import { HiveError, errorMessage, newId, nowIso, secretRedactor } from '@hive/shared';
import { sha256, type MarketplaceRegistry } from './registry';

const INSTALLED_KEY = 'marketplace:installed';
const MAX_PACKAGE_BYTES = 1024 * 1024;
/** Tools that change the project or run things; the preview marks them. */
const SENSITIVE: ReadonlySet<ToolName> = new Set([
  'write_file',
  'replace_in_file',
  'run_command',
  'web_fetch',
]);

export interface MarketplaceOptions {
  repos: Repositories;
  /** Read when needed, not at start: the app may not say it yet. */
  hiveVersion: () => string;
  registries: () => MarketplaceRegistry[];
  skills: {
    list: () => Promise<SkillSummary[]>;
    save: (raw: string) => Promise<unknown>;
    raw: (name: string) => Promise<string | null>;
  };
  /** A new agent joins the project's Nectar, as one made by hand does. */
  connectWorker: (workerId: string) => void;
  onChange: (workerIds: string[]) => void;
  save: (defaultName: string, content: string) => Promise<string | null>;
  /** The text of a package file the user picks; null when cancelled. */
  open: () => Promise<string | null>;
}

interface Checked {
  package: MarketplacePackage | null;
  problem: string | null;
}

/** The fields of a worker a package sets, and so the ones an update may change. */
const fields = (agent: MarketplaceAgent) => ({
  name: agent.name,
  role: agent.role,
  description: agent.description,
  systemPrompt: agent.instructions,
  tools: agent.tools,
  skills: agent.skills,
  beeColor: agent.color ?? null,
});
type AgentFields = ReturnType<typeof fields>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Hive Marketplace: lists the packages of every source, checks each one (integrity, schema,
 * keys inside, compatibility), and installs agents, teams and skills as ordinary Hive agents
 * and skills, never with anything that runs on its own. Updates keep what the user changed.
 */
export class Marketplace {
  private catalogCache: MarketplaceCatalog | null = null;
  /** Package files the user opened from disk, waiting for the yes. */
  private readonly imported = new Map<string, string>();

  constructor(private readonly options: MarketplaceOptions) {}

  /** Everything a package text must pass before it is listed or installed. */
  check(raw: string, expectedSha?: string): Checked {
    if (raw.length > MAX_PACKAGE_BYTES)
      return { package: null, problem: 'O pacote passa de 1 MB.' };
    if (expectedSha && sha256(raw) !== expectedSha)
      return {
        package: null,
        problem:
          'O conteúdo não confere com o hash do índice: o pacote foi alterado depois de publicado.',
      };
    // A key or token in a package is refused whatever field it hides in.
    if (secretRedactor.redact(raw) !== raw)
      return {
        package: null,
        problem:
          'O pacote contém um texto com formato de chave ou token; por segurança, não é aceito.',
      };
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return { package: null, problem: 'O arquivo não é um JSON válido.' };
    }
    const parsed = marketplacePackageSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      const where = issue.path.join('.');
      return {
        package: null,
        problem:
          issue.code === 'unrecognized_keys'
            ? `O pacote traz campos que um pacote não pode ter (${issue.keys.join(', ')}${where ? ` em ${where}` : ''}): pacotes só carregam configurações declarativas.`
            : `Pacote inválido${where ? ` (${where})` : ''}: ${issue.message}`,
      };
    }
    const pkg = parsed.data;
    if (compareVersions(this.options.hiveVersion(), pkg.minHiveVersion) < 0)
      return {
        package: pkg,
        problem: `Precisa do Hive ${pkg.minHiveVersion} ou mais novo (este é ${this.options.hiveVersion()}).`,
      };
    if (!installableCategories.has(pkg.category))
      return {
        package: pkg,
        problem:
          'Esta versão do Hive instala só agentes, equipes e skills (configurações declarativas).',
      };
    return { package: pkg, problem: null };
  }

  installed(): MarketplaceInstalled[] {
    try {
      const value: unknown = JSON.parse(this.options.repos.getValue(INSTALLED_KEY) ?? '[]');
      return Array.isArray(value) ? (value as MarketplaceInstalled[]) : [];
    } catch {
      return [];
    }
  }

  private saveInstalled(items: MarketplaceInstalled[]): void {
    this.options.repos.setValue(INSTALLED_KEY, JSON.stringify(items));
  }

  private manifestKey = (id: string, version: string) => `marketplace:manifest:${id}@${version}`;

  private manifest(id: string, version: string): MarketplacePackage | null {
    const raw = this.options.repos.getValue(this.manifestKey(id, version));
    return raw ? (this.check(raw).package ?? null) : null;
  }

  registryUrl(): string | null {
    return this.options.repos.getValue('marketplace:registryUrl') || null;
  }

  setRegistryUrl(url: string | null): void {
    this.options.repos.setValue('marketplace:registryUrl', url ?? '');
    this.catalogCache = null;
  }

  /** The packages of every source; read again with `refresh`, else from the last read. */
  async catalog(refresh = false): Promise<MarketplaceCatalog> {
    if (this.catalogCache && !refresh) return this.withInstalled(this.catalogCache);
    const listings: MarketplaceListing[] = [];
    const rejected: MarketplaceCatalog['rejected'] = [];
    for (const registry of this.options.registries()) {
      let entries;
      try {
        entries = (await registry.index()).packages;
      } catch (error) {
        rejected.push({ source: registry.label, path: 'index.json', problem: errorMessage(error) });
        continue;
      }
      for (const entry of entries) {
        let raw: string;
        try {
          raw = await registry.read(entry.path);
        } catch (error) {
          rejected.push({ source: registry.label, path: entry.path, problem: errorMessage(error) });
          continue;
        }
        const checked = this.check(raw, entry.sha256);
        if (!checked.package) {
          rejected.push({ source: registry.label, path: entry.path, problem: checked.problem! });
          continue;
        }
        if (checked.package.id !== entry.id || checked.package.version !== entry.version) {
          rejected.push({
            source: registry.label,
            path: entry.path,
            problem: 'O id ou a versão não conferem com o índice.',
          });
          continue;
        }
        this.raws.set(`${registry.id}:${entry.id}`, raw);
        listings.push({
          source: registry.label,
          package: checked.package,
          installable: !checked.problem,
          problem: checked.problem,
          installedVersion: null,
          updateAvailable: false,
        });
      }
    }
    this.catalogCache = { listings, rejected, registryUrl: this.registryUrl(), syncedAt: nowIso() };
    return this.withInstalled(this.catalogCache);
  }

  /** Package texts read from the sources, by "<registry>:<id>". */
  private readonly raws = new Map<string, string>();

  private withInstalled(catalog: MarketplaceCatalog): MarketplaceCatalog {
    const installed = new Map(this.installed().map((item) => [item.packageId, item]));
    return {
      ...catalog,
      listings: catalog.listings.map((listing) => {
        const mine = installed.get(listing.package.id);
        return {
          ...listing,
          installedVersion: mine?.version ?? null,
          updateAvailable: !!mine && compareVersions(listing.package.version, mine.version) > 0,
        };
      }),
    };
  }

  private async find(
    source: string,
    id: string,
  ): Promise<{ raw: string; listing: MarketplaceListing }> {
    const catalog = await this.catalog();
    const listing = catalog.listings.find(
      (item) => item.package.id === id && item.source === source,
    );
    const registry = this.options.registries().find((item) => item.label === source);
    const raw = registry ? this.raws.get(`${registry.id}:${id}`) : undefined;
    if (!listing || !raw)
      throw new HiveError('NOT_FOUND', `Pacote ${id} não encontrado em ${source}.`);
    return { raw, listing };
  }

  /** What installing would do, for the confirmation the page shows first. */
  async preview(source: string, id: string): Promise<MarketplacePreview> {
    const { listing } = await this.find(source, id);
    return this.describe(listing);
  }

  private async describe(listing: MarketplaceListing): Promise<MarketplacePreview> {
    const pkg = listing.package;
    const existing = new Set((await this.options.skills.list()).map((skill) => skill.name));
    const brought = pkg.skills.map((skill) => skill.name);
    const used = [...new Set(pkg.agents.flatMap((agent) => agent.skills))];
    const installedIds = new Set(this.installed().map((item) => item.packageId));
    const warnings: string[] = [];
    if (pkg.agents.length)
      warnings.push(
        'Os agentes chegam sem modelo: escolha o provedor e o modelo de cada um na aba Agentes antes de usá-los.',
      );
    if (pkg.permissions.includes('run_command'))
      warnings.push(
        'run_command continua pedindo sua aprovação para comandos fora da lista segura.',
      );
    return {
      listing,
      permissions: pkg.permissions.map((tool) => ({
        tool,
        description: toolDescriptions[tool],
        sensitive: SENSITIVE.has(tool),
      })),
      newSkills: brought.filter((name) => !existing.has(name)),
      keptSkills: brought.filter((name) => existing.has(name)),
      missingSkills: used.filter((name) => !existing.has(name) && !brought.includes(name)),
      missingDependencies: pkg.dependencies
        .filter((dependency) => !installedIds.has(dependency.id))
        .map((dependency) => `${dependency.id} ${dependency.version}`),
      warnings,
    };
  }

  async install(source: string, id: string): Promise<MarketplaceInstalled> {
    const { raw, listing } = await this.find(source, id);
    return this.installRaw(raw, listing.source);
  }

  /** Opens a package file and checks it; installing it is a second step, after the preview. */
  async importFile(): Promise<{ token: string; preview: MarketplacePreview } | null> {
    const raw = await this.options.open();
    if (raw === null) return null;
    const checked = this.check(raw);
    if (!checked.package) throw new HiveError('VALIDATION', checked.problem!);
    const token = newId('import');
    this.imported.set(token, raw);
    const preview = await this.describe({
      source: 'Arquivo',
      package: checked.package,
      installable: !checked.problem,
      problem: checked.problem,
      installedVersion:
        this.installed().find((item) => item.packageId === checked.package!.id)?.version ?? null,
      updateAvailable: false,
    });
    return { token, preview };
  }

  async installImported(token: string): Promise<MarketplaceInstalled> {
    const raw = this.imported.get(token);
    if (!raw) throw new HiveError('NOT_FOUND', 'Abra o arquivo de novo.');
    const result = await this.installRaw(raw, 'Arquivo');
    this.imported.delete(token);
    return result;
  }

  private async installRaw(raw: string, source: string): Promise<MarketplaceInstalled> {
    const checked = this.check(raw);
    if (!checked.package || checked.problem)
      throw new HiveError('VALIDATION', checked.problem ?? 'Pacote inválido.');
    const pkg = checked.package;
    if (this.installed().some((item) => item.packageId === pkg.id))
      throw new HiveError(
        'CONFLICT',
        `${pkg.name} já está instalado. Use Atualizar para outra versão.`,
      );
    const skills = await this.addSkills(pkg);
    const { repos } = this.options;
    const taken = new Set(repos.workers.list().map((worker) => worker.name.toLowerCase()));
    const workers: Record<string, string> = {};
    for (const agent of pkg.agents) {
      const at = nowIso();
      const name = taken.has(agent.name.toLowerCase())
        ? `${agent.name} (Marketplace)`.slice(0, 60)
        : agent.name;
      taken.add(name.toLowerCase());
      const worker: Worker = {
        id: newId('worker'),
        ...fields(agent),
        name,
        squad: [],
        // Personal choices are never in a package: the user picks the model.
        providerId: null,
        modelId: null,
        mcpServers: [],
        autoApproveCommands: [],
        limits: defaultLimits,
        createdAt: at,
        updatedAt: at,
      };
      repos.workers.put(worker);
      this.options.connectWorker(worker.id);
      workers[agent.key] = worker.id;
    }
    const record: MarketplaceInstalled = {
      packageId: pkg.id,
      name: pkg.name,
      category: pkg.category,
      version: pkg.version,
      source,
      installedAt: nowIso(),
      workers,
      skills,
      history: [],
    };
    repos.setValue(this.manifestKey(pkg.id, pkg.version), raw);
    this.saveInstalled([...this.installed(), record]);
    this.options.onChange(Object.values(workers));
    return record;
  }

  /** Writes the package's skills that this Hive does not have; one already here stays as is. */
  private async addSkills(pkg: MarketplacePackage): Promise<string[]> {
    const existing = new Set((await this.options.skills.list()).map((skill) => skill.name));
    const added: string[] = [];
    for (const skill of pkg.skills) {
      if (existing.has(skill.name)) continue;
      try {
        await this.options.skills.save(skill.raw);
      } catch (error) {
        throw new HiveError(
          'VALIDATION',
          `A skill “${skill.name}” do pacote é inválida: ${errorMessage(error)}`,
        );
      }
      added.push(skill.name);
    }
    return added;
  }

  /**
   * Moves an installed package to `next`. A field the user never changed follows the package;
   * one the user changed stays theirs. New agents of the package are added; an agent the new
   * version no longer has is kept, since the user may rely on it.
   */
  private async move(
    record: MarketplaceInstalled,
    from: MarketplacePackage,
    next: MarketplacePackage,
    raw: string,
  ) {
    const { repos } = this.options;
    const kept: string[] = [];
    const workers = { ...record.workers };
    await this.addSkills(next);
    for (const agent of next.agents) {
      const workerId = workers[agent.key];
      const worker = workerId ? repos.workers.get(workerId) : null;
      const before = from.agents.find((item) => item.key === agent.key);
      if (!worker || !before) {
        const at = nowIso();
        const created: Worker = {
          id: newId('worker'),
          ...fields(agent),
          squad: [],
          providerId: null,
          modelId: null,
          mcpServers: [],
          autoApproveCommands: [],
          limits: defaultLimits,
          createdAt: at,
          updatedAt: at,
        };
        repos.workers.put(created);
        this.options.connectWorker(created.id);
        workers[agent.key] = created.id;
        continue;
      }
      const old = fields(before);
      const fresh = fields(agent);
      const patch: Partial<AgentFields> = {};
      for (const key of Object.keys(fresh) as (keyof AgentFields)[]) {
        if (same(worker[key], old[key])) Object.assign(patch, { [key]: fresh[key] });
        else if (!same(old[key], fresh[key])) kept.push(`${worker.name}: ${key}`);
      }
      repos.workers.put({ ...worker, ...patch, updatedAt: nowIso() });
    }
    repos.setValue(this.manifestKey(next.id, next.version), raw);
    const updated: MarketplaceInstalled = {
      ...record,
      name: next.name,
      version: next.version,
      workers,
      history: [{ version: record.version, at: nowIso() }, ...record.history].slice(0, 10),
    };
    this.saveInstalled(
      this.installed().map((item) => (item.packageId === record.packageId ? updated : item)),
    );
    this.options.onChange(Object.values(workers));
    return { installed: updated, kept };
  }

  private require(id: string): { record: MarketplaceInstalled; current: MarketplacePackage } {
    const record = this.installed().find((item) => item.packageId === id);
    if (!record) throw new HiveError('NOT_FOUND', 'Este pacote não está instalado.');
    const current = this.manifest(id, record.version);
    if (!current)
      throw new HiveError('NOT_FOUND', 'A versão instalada não foi guardada; reinstale o pacote.');
    return { record, current };
  }

  /** Updates to the newest version of its source, keeping the user's changes. */
  async update(id: string): Promise<{ installed: MarketplaceInstalled; kept: string[] }> {
    const { record, current } = this.require(id);
    const catalog = await this.catalog(true);
    const listing = catalog.listings
      .filter((item) => item.package.id === id && item.installable)
      .sort((a, b) => compareVersions(b.package.version, a.package.version))[0];
    if (!listing || compareVersions(listing.package.version, record.version) <= 0)
      throw new HiveError('CONFLICT', 'Não há versão mais nova.');
    const { raw } = await this.find(listing.source, id);
    return this.move(record, current, listing.package, raw);
  }

  /** Goes back to the version installed before the last update. */
  async restore(id: string): Promise<{ installed: MarketplaceInstalled; kept: string[] }> {
    const { record, current } = this.require(id);
    const previous = record.history[0];
    if (!previous) throw new HiveError('CONFLICT', 'Não há versão anterior para voltar.');
    const raw = this.options.repos.getValue(this.manifestKey(id, previous.version));
    const older = raw ? this.check(raw).package : null;
    if (!raw || !older)
      throw new HiveError('NOT_FOUND', `A versão ${previous.version} não foi guardada.`);
    const moved = await this.move(
      { ...record, history: record.history.slice(1) },
      current,
      older,
      raw,
    );
    // Going back is not a new step forward: the version left is not added to the history.
    const fixed = { ...moved.installed, history: record.history.slice(1) };
    this.saveInstalled(this.installed().map((item) => (item.packageId === id ? fixed : item)));
    return { installed: fixed, kept: moved.kept };
  }

  /** Removes the package's agents; refused while one of them works on a mission. */
  uninstall(id: string): void {
    const { repos } = this.options;
    const record = this.installed().find((item) => item.packageId === id);
    if (!record) return;
    const ids = new Set(Object.values(record.workers));
    const busy = repos.tasks
      .list()
      .some(
        (task) =>
          task.workerId &&
          ids.has(task.workerId) &&
          ['running', 'waiting_approval'].includes(task.status),
      );
    if (busy)
      throw new HiveError(
        'CONFLICT',
        'Um agente deste pacote está trabalhando agora. Espere a tarefa terminar ou cancele-a.',
      );
    for (const workerId of ids) repos.workers.delete(workerId);
    this.saveInstalled(this.installed().filter((item) => item.packageId !== id));
    this.options.onChange([...ids]);
  }

  /**
   * Turns agents of this Hive into a package, with nothing personal: no provider, model, keys,
   * commands approved in advance, MCP servers or memories. Instructions with something shaped
   * like a key are refused rather than shared.
   */
  async export(input: MarketplaceExport): Promise<string | null> {
    const workers = input.workerIds.map((workerId) =>
      this.options.repos.workers.require(workerId, 'Agente'),
    );
    if (workers.some((worker) => worker.role === 'queen'))
      throw new HiveError('VALIDATION', 'A Queen não entra em pacotes.');
    const keys = new Set<string>();
    const agents: MarketplaceAgent[] = workers.map((worker) => {
      const base =
        worker.name
          .normalize('NFD')
          .replace(/[̀-ͯ]/g, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 34) || 'agente';
      let key = base;
      for (let n = 2; keys.has(key); n++) key = `${base}-${n}`;
      keys.add(key);
      return {
        key,
        name: worker.name,
        role: worker.role as MarketplaceAgent['role'],
        description: worker.description,
        instructions: worker.systemPrompt,
        tools: worker.tools,
        skills: worker.skills,
        recommendedModels: [],
        ...(worker.beeColor && /^#[0-9a-f]{6}$/i.test(worker.beeColor)
          ? { color: worker.beeColor }
          : {}),
      };
    });
    const skills: MarketplacePackage['skills'] = [];
    if (input.includeSkills) {
      const library = await this.options.skills.list();
      const wanted = new Set(workers.flatMap((worker) => worker.skills));
      for (const skill of library) {
        // Hive's own skills are in every Hive; skills with scripts carry code, which stays out.
        if (
          !wanted.has(skill.name) ||
          skill.source !== 'local' ||
          skill.builtin ||
          skill.hasScripts
        )
          continue;
        const raw = await this.options.skills.raw(skill.name);
        if (raw) skills.push({ name: skill.name, raw });
      }
    }
    const pkg: MarketplacePackage = {
      schemaVersion: 1,
      id: input.id,
      name: input.name,
      description: input.description,
      author: { name: input.author },
      version: input.version,
      license: input.license,
      category: agents.length > 1 ? 'team' : 'agent',
      tags: input.tags,
      minHiveVersion: this.options.hiveVersion(),
      agents,
      skills,
      dependencies: [],
      permissions: [...new Set(agents.flatMap((agent) => agent.tools))],
    };
    const text = `${JSON.stringify(pkg, null, 2)}\n`;
    const checked = this.check(text);
    if (!checked.package)
      throw new HiveError('VALIDATION', `O pacote não pode ser exportado: ${checked.problem}`);
    return this.options.save(`${pkg.id}-${pkg.version}.json`, text);
  }
}
