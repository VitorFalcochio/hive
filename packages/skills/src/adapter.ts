import { execFile } from 'node:child_process';
import { cp, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SkillDetail, SkillDiagnostic, SkillSummary, SkillValidation } from '@hive/core';
import { HiveError, errorMessage, newId } from '@hive/shared';
import { discoverSkillDirectories, exists, listSkillFiles, readTextFile } from './filesystem';
import { parseSkillMarkdown, skillNameSchema } from './format';
import { validateSkillDirectory, validateSkillText } from './validator';

export interface SkillForgeAdapterOptions {
  /** A SkillForge checkout (repository root) or any folder laid out as `<category>/<skill>/SKILL.md`. */
  catalogPath: string | null;
  /** Hive's own skill library (installed and user-created skills). */
  libraryDir: string;
  /** Delegate validation to the SkillForge CLI when the checkout has been built. */
  cliValidation: boolean;
  /** How to run the SkillForge CLI with Node. Injected so Electron can use ELECTRON_RUN_AS_NODE. */
  nodeCommand?: { command: string; env: NodeJS.ProcessEnv };
}

export interface ResolvedSkill {
  name: string;
  description: string;
  body: string;
  directory: string;
  source: 'skillforge' | 'local';
  resources: string[];
}

type Source = 'skillforge' | 'local';

/**
 * Hive's integration with a local SkillForge catalog. It reads the same portable format and
 * discovery rules as SkillForge, installs skills into Hive's own library (SkillForge installs
 * into agent folders such as .claude/skills, which Hive does not use), and can delegate
 * validation to SkillForge's CLI. It never executes code shipped inside a skill.
 */
export class SkillForgeAdapter {
  constructor(private readonly options: SkillForgeAdapterOptions) {}

  async catalogSkillsRoot(): Promise<string | null> {
    const base = this.options.catalogPath;
    if (!base) return null;
    const nested = path.join(base, 'skills');
    if (await isDirectory(nested)) return nested;
    return (await isDirectory(base)) ? base : null;
  }

  private async cliPath(): Promise<string | null> {
    const base = this.options.catalogPath;
    if (!base) return null;
    for (const candidate of [path.join(base, 'packages/cli/dist/index.js'), path.join(base, '../packages/cli/dist/index.js')]) {
      if (await exists(candidate)) return candidate;
    }
    return null;
  }

  async cliAvailable(): Promise<boolean> {
    return (await this.cliPath()) !== null;
  }

  private async summarize(directory: string, source: Source, root: string): Promise<SkillSummary> {
    const files = await listSkillFiles(directory).catch(() => []);
    const base = {
      source,
      category: source === 'local' ? 'local' : path.relative(root, path.dirname(directory)).split(path.sep).join('/') || '.',
      resources: files.map((file) => file.relative).filter((file) => file !== 'SKILL.md'),
      hasScripts: files.some((file) => file.relative.startsWith('scripts/')),
      installed: source === 'local',
      directory,
    };
    try {
      const parsed = parseSkillMarkdown(await readTextFile(path.join(directory, 'SKILL.md')));
      return {
        ...base,
        name: parsed.metadata.name,
        description: parsed.metadata.description,
        license: parsed.metadata.license ?? null,
        compatibility: parsed.metadata.compatibility ?? null,
        allowedTools: parsed.metadata['allowed-tools'] ?? null,
      };
    } catch (error) {
      return {
        ...base,
        name: path.basename(directory),
        description: `Cannot read SKILL.md: ${errorMessage(error)}`,
        license: null,
        compatibility: null,
        allowedTools: null,
      };
    }
  }

  async listCatalog(): Promise<SkillSummary[]> {
    const root = await this.catalogSkillsRoot();
    if (!root) return [];
    const directories = await discoverSkillDirectories(root);
    return Promise.all(directories.map((directory) => this.summarize(directory, 'skillforge', root)));
  }

  async listLocal(): Promise<SkillSummary[]> {
    await mkdir(this.options.libraryDir, { recursive: true });
    const directories = await discoverSkillDirectories(this.options.libraryDir);
    return Promise.all(directories.map((directory) => this.summarize(directory, 'local', this.options.libraryDir)));
  }

  async list(): Promise<SkillSummary[]> {
    const [local, catalog] = await Promise.all([this.listLocal(), this.listCatalog()]);
    const installed = new Set(local.map((skill) => skill.name));
    return [...local, ...catalog.map((skill) => ({ ...skill, installed: installed.has(skill.name) }))].sort(
      (a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source),
    );
  }

  private async directoryFor(name: string, source: Source): Promise<string> {
    skillNameSchema.parse(name);
    if (source === 'local') {
      const directory = path.join(this.options.libraryDir, name);
      if (!(await exists(path.join(directory, 'SKILL.md')))) throw new HiveError('NOT_FOUND', `Local skill not found: ${name}`);
      return directory;
    }
    const root = await this.catalogSkillsRoot();
    if (!root) throw new HiveError('SKILL', 'No SkillForge catalog is connected.');
    const directory = (await discoverSkillDirectories(root)).find((dir) => path.basename(dir) === name);
    if (!directory) throw new HiveError('NOT_FOUND', `Skill not found in catalog: ${name}`);
    return directory;
  }

  async get(name: string, source: Source): Promise<SkillDetail> {
    const directory = await this.directoryFor(name, source);
    const root = source === 'local' ? this.options.libraryDir : ((await this.catalogSkillsRoot()) ?? directory);
    const summary = await this.summarize(directory, source, root);
    const raw = await readTextFile(path.join(directory, 'SKILL.md'));
    let body = raw;
    try {
      body = parseSkillMarkdown(raw).body;
    } catch {
      // keep raw body; validation reports the problem
    }
    if (source === 'skillforge') summary.installed = await exists(path.join(this.options.libraryDir, name, 'SKILL.md'));
    return { ...summary, raw, body };
  }

  async validate(name: string, source: Source): Promise<SkillValidation> {
    const directory = await this.directoryFor(name, source);
    if (this.options.cliValidation) {
      const cli = await this.cliPath();
      if (cli) return this.validateWithCli(cli, directory);
    }
    const diagnostics = await validateSkillDirectory(directory);
    return { valid: !diagnostics.some((d) => d.severity === 'error'), validator: 'hive', diagnostics };
  }

  validateDraft(raw: string): SkillValidation {
    const { diagnostics } = validateSkillText(raw, null);
    return { valid: !diagnostics.some((d) => d.severity === 'error'), validator: 'hive', diagnostics };
  }

  private validateWithCli(cli: string, directory: string): Promise<SkillValidation> {
    const runner = this.options.nodeCommand ?? { command: process.execPath, env: process.env };
    return new Promise((resolve, reject) => {
      execFile(
        runner.command,
        [cli, 'validate', directory, '--json'],
        { env: runner.env, timeout: 60_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout) => {
          try {
            const result = JSON.parse(stdout) as {
              valid: boolean;
              diagnostics: { severity: 'error' | 'warning'; code: string; path: string; message: string; line?: number }[];
            };
            const diagnostics: SkillDiagnostic[] = result.diagnostics.map((item) => ({
              severity: item.severity,
              code: item.code,
              message: item.message,
              file: item.path ? `${path.relative(directory, item.path).split(path.sep).join('/') || 'SKILL.md'}${item.line ? `:${item.line}` : ''}` : null,
            }));
            resolve({ valid: result.valid, validator: 'skillforge-cli', diagnostics });
          } catch {
            reject(new HiveError('SKILL', `SkillForge CLI validation failed: ${error ? errorMessage(error) : 'unexpected output'}`));
          }
        },
      );
    });
  }

  /** Copy a catalog skill into Hive's library after validating it. Replaces an older copy. */
  async install(name: string): Promise<SkillSummary> {
    const source = await this.directoryFor(name, 'skillforge');
    const before = await validateSkillDirectory(source);
    const errors = before.filter((d) => d.severity === 'error');
    if (errors.length) throw new HiveError('SKILL', `Skill is invalid: ${errors.map((d) => d.message).join('; ')}`);
    await mkdir(this.options.libraryDir, { recursive: true });
    const staging = path.join(this.options.libraryDir, `.staging-${newId('skill')}`);
    const destination = path.join(this.options.libraryDir, name);
    try {
      // Regular files only (listSkillFiles rejects links); copies keep content, not permissions.
      for (const file of await listSkillFiles(source)) {
        const target = path.join(staging, ...file.relative.split('/'));
        await mkdir(path.dirname(target), { recursive: true });
        await cp(path.join(source, ...file.relative.split('/')), target, { verbatimSymlinks: true });
      }
      const after = await validateSkillDirectory(staging).then((items) => items.filter((d) => d.code !== 'NAME_MISMATCH'));
      if (after.some((d) => d.severity === 'error')) throw new HiveError('SKILL', 'Copied skill failed validation.');
      await rm(destination, { recursive: true, force: true });
      await rename(staging, destination);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    return this.summarize(destination, 'local', this.options.libraryDir);
  }

  /** Create or update a skill in Hive's library from SKILL.md text. */
  async saveLocal(raw: string, originalName?: string): Promise<SkillSummary> {
    const { parsed, diagnostics } = validateSkillText(raw, null);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    if (!parsed || errors.length) throw new HiveError('SKILL', errors.map((d) => d.message).join('; ') || 'Invalid SKILL.md');
    const name = parsed.metadata.name;
    const destination = path.join(this.options.libraryDir, name);
    if (originalName && originalName !== name) {
      skillNameSchema.parse(originalName);
      if (await exists(destination)) throw new HiveError('CONFLICT', `A local skill named "${name}" already exists.`);
      const previous = path.join(this.options.libraryDir, originalName);
      if (await exists(previous)) await rename(previous, destination);
    } else if (!originalName && (await exists(destination))) {
      throw new HiveError('CONFLICT', `A local skill named "${name}" already exists.`);
    }
    await mkdir(destination, { recursive: true });
    const file = path.join(destination, 'SKILL.md');
    const temporary = `${file}.${newId('tmp')}`;
    await writeFile(temporary, raw.replace(/\r\n/g, '\n'), 'utf8');
    await rename(temporary, file);
    return this.summarize(destination, 'local', this.options.libraryDir);
  }

  async deleteLocal(name: string): Promise<void> {
    const directory = await this.directoryFor(name, 'local');
    await rm(directory, { recursive: true, force: true });
  }

  /** Load the skills assigned to a worker: Hive's library first, then the catalog. */
  async resolve(names: string[]): Promise<{ skills: ResolvedSkill[]; missing: string[] }> {
    const skills: ResolvedSkill[] = [];
    const missing: string[] = [];
    for (const name of names) {
      let resolved: ResolvedSkill | null = null;
      for (const source of ['local', 'skillforge'] as const) {
        try {
          const detail = await this.get(name, source);
          const parsed = parseSkillMarkdown(detail.raw);
          resolved = {
            name,
            description: parsed.metadata.description,
            body: parsed.body.trim(),
            directory: detail.directory,
            source,
            resources: detail.resources,
          };
          break;
        } catch {
          // try next source
        }
      }
      if (resolved) skills.push(resolved);
      else missing.push(name);
    }
    return { skills, missing };
  }
}

async function isDirectory(target: string): Promise<boolean> {
  return (await stat(target).catch(() => null))?.isDirectory() ?? false;
}
