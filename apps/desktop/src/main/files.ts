import { watch, type FSWatcher } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FileContent, FileEntry, FileDiffContent, GitStatusSummary } from '@hive/core';
import { HiveError, resolveInside, toPosixRelative } from '@hive/shared';
import { git, inspectRepository, statusPorcelain } from '@hive/workspace';

const MAX_EDITABLE_BYTES = 5 * 1024 * 1024;
/** Folders that are noise in an explorer and in change notifications. */
const HIDDEN = new Set(['.git']);
const QUIET = new Set(['.git', 'node_modules', '.local', 'dist', 'out', '.next', 'coverage']);

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

/**
 * File access for the editor, always confined to the active workspace folder. Paths crossing the
 * IPC boundary are relative with forward slashes.
 */
export class FileService {
  private watcher: FSWatcher | null = null;
  private watchedRoot: string | null = null;
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly root: () => string | null,
    private readonly onFilesChanged: (paths: string[]) => void,
  ) {}

  private requireRoot(): string {
    const root = this.root();
    if (!root) throw new HiveError('VALIDATION', 'Abra um repositório primeiro.');
    return root;
  }

  private async resolve(relative: string): Promise<{ root: string; full: string; rel: string }> {
    const root = this.requireRoot();
    const full = await resolveInside(root, relative || '.');
    const rel = toPosixRelative(root, full);
    if (rel.split('/').includes('.git'))
      throw new HiveError('FORBIDDEN_PATH', 'A pasta .git não pode ser acessada pelo editor.');
    return { root, full, rel };
  }

  async list(relative: string): Promise<FileEntry[]> {
    const { full, rel } = await this.resolve(relative);
    const entries = await readdir(full, { withFileTypes: true });
    return entries
      .filter((entry) => !HIDDEN.has(entry.name))
      .map((entry) => ({
        name: entry.name,
        path: rel === '.' ? entry.name : `${rel}/${entry.name}`,
        kind: entry.isDirectory() ? ('dir' as const) : ('file' as const),
      }))
      .sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name, 'pt-BR') : a.kind === 'dir' ? -1 : 1,
      );
  }

  /** Every project file for quick open, respecting .gitignore. */
  async files(): Promise<string[]> {
    const root = this.requireRoot();
    const result = await git(
      root,
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      {
        allowFailure: true,
      },
    );
    if (result.code !== 0) return [];
    return [...new Set(result.stdout.split('\0').filter(Boolean))].slice(0, 50_000);
  }

  async read(relative: string): Promise<FileContent> {
    const { full, rel } = await this.resolve(relative);
    const info = await stat(full);
    if (!info.isFile()) throw new HiveError('VALIDATION', 'Não é um arquivo.');
    const base = { path: rel, size: info.size, mtimeMs: info.mtimeMs };
    if (info.size > MAX_EDITABLE_BYTES)
      return { ...base, content: null, binary: false, tooLarge: true };
    const buffer = await readFile(full);
    if (isBinary(buffer)) return { ...base, content: null, binary: true, tooLarge: false };
    return { ...base, content: buffer.toString('utf8'), binary: false, tooLarge: false };
  }

  /**
   * Save a file. When `expectedMtimeMs` is given and the file changed on disk since it was read,
   * nothing is written and a CONFLICT is raised, so edits from elsewhere are never lost silently.
   */
  async write(
    relative: string,
    content: string,
    expectedMtimeMs: number | null,
  ): Promise<{ mtimeMs: number }> {
    const { full } = await this.resolve(relative);
    if (expectedMtimeMs !== null) {
      const current = await stat(full).catch(() => null);
      if (current && Math.abs(current.mtimeMs - expectedMtimeMs) > 1)
        throw new HiveError(
          'CONFLICT',
          'O arquivo foi alterado fora do editor desde que você o abriu. Recarregue ou salve por cima.',
        );
    }
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
    return { mtimeMs: (await stat(full)).mtimeMs };
  }

  async create(relative: string, kind: 'file' | 'dir'): Promise<void> {
    const { full } = await this.resolve(relative);
    if (
      await lstat(full).then(
        () => true,
        () => false,
      )
    )
      throw new HiveError('CONFLICT', 'Já existe um arquivo ou pasta com esse nome.');
    if (kind === 'dir') await mkdir(full, { recursive: true });
    else {
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, '', { flag: 'wx' });
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const source = await this.resolve(from);
    const target = await this.resolve(to);
    if (
      await lstat(target.full).then(
        () => true,
        () => false,
      )
    )
      throw new HiveError('CONFLICT', 'Já existe um arquivo ou pasta com esse nome.');
    await mkdir(path.dirname(target.full), { recursive: true });
    await rename(source.full, target.full);
  }

  /** Absolute path, for moving to the recycle bin from the Electron side. */
  async absolute(relative: string): Promise<string> {
    const { full, rel } = await this.resolve(relative);
    if (rel === '.')
      throw new HiveError('FORBIDDEN_PATH', 'A raiz do projeto não pode ser removida.');
    return full;
  }

  async gitStatus(): Promise<GitStatusSummary> {
    const root = this.requireRoot();
    const [repo, files] = await Promise.all([inspectRepository(root), statusPorcelain(root)]);
    return { branch: repo.branch, files };
  }

  /** HEAD version against the working copy, for the user's own changes. */
  async workingDiff(relative: string): Promise<FileDiffContent> {
    const { root, full, rel } = await this.resolve(relative);
    const original = await this.show(root, 'HEAD', rel);
    const modified = await readFile(full, 'utf8').catch(() => '');
    return { path: rel, original, modified };
  }

  /** One file of an agent task: start commit against the task's result commit. */
  async commitDiff(
    repoRoot: string,
    from: string,
    to: string,
    rel: string,
  ): Promise<FileDiffContent> {
    const [original, modified] = await Promise.all([
      this.show(repoRoot, from, rel),
      this.show(repoRoot, to, rel),
    ]);
    return { path: rel, original, modified };
  }

  private async show(root: string, ref: string, rel: string): Promise<string> {
    const result = await git(root, ['show', `${ref}:${rel}`], { allowFailure: true });
    return result.code === 0 ? result.stdout : '';
  }

  async branches(): Promise<{ current: string | null; local: string[] }> {
    const root = this.requireRoot();
    const [repo, list] = await Promise.all([
      inspectRepository(root),
      git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    ]);
    return { current: repo.branch, local: list.stdout.split('\n').filter(Boolean) };
  }

  /** Switch branch only when no tracked file has uncommitted changes. */
  async checkout(branch: string): Promise<void> {
    const root = this.requireRoot();
    const modified = (await statusPorcelain(root)).filter((file) => file.status !== '??');
    if (modified.length)
      throw new HiveError(
        'CONFLICT',
        `Há ${modified.length} arquivo(s) com alterações não commitadas. Faça commit ou descarte antes de trocar de branch.`,
      );
    const known = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      allowFailure: true,
    });
    if (known.code !== 0) throw new HiveError('NOT_FOUND', `Branch não encontrada: ${branch}`);
    await git(root, ['checkout', branch]);
  }

  /** Watch the active workspace and report changed paths, batched. */
  watch(): void {
    const root = this.root();
    if (root === this.watchedRoot) return;
    this.watcher?.close();
    this.watcher = null;
    this.watchedRoot = root;
    if (!root) return;
    try {
      this.watcher = watch(root, { recursive: true }, (_event, name) => {
        if (!name) return;
        const rel = name.split(path.sep).join('/');
        const top = rel.split('/')[0] ?? '';
        // Branch switches show up as .git/HEAD changes.
        if (QUIET.has(top) && rel !== '.git/HEAD') return;
        this.pending.add(rel);
        this.timer ??= setTimeout(() => {
          this.timer = null;
          const paths = [...this.pending];
          this.pending.clear();
          this.onFilesChanged(paths);
        }, 200);
      });
      this.watcher.on('error', () => undefined);
    } catch {
      // Watching is a convenience; the editor still works without it.
    }
  }

  dispose(): void {
    this.watcher?.close();
    if (this.timer) clearTimeout(this.timer);
  }
}
