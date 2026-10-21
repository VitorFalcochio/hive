import { watch, type FSWatcher } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  FileContent,
  FileEntry,
  FileDiffContent,
  GitStatusSummary,
  SearchMatch,
  SearchOptions,
  SearchResult,
} from '@hive/core';
import { HiveError, resolveInside, toPosixRelative } from '@hive/shared';
import { git, inspectRepository, statusPorcelain } from '@hive/workspace';

const MAX_EDITABLE_BYTES = 5 * 1024 * 1024;
/** Folders that are noise in an explorer and in change notifications. */
const HIDDEN = new Set(['.git']);
const QUIET = new Set(['.git', 'node_modules', '.local', 'dist', 'out', '.next', 'coverage']);

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

const MAX_NAME_RESULTS = 50;
const MAX_CONTENT_RESULTS = 2_000;
const MAX_LINE_CHARS = 400;

/**
 * The same rules git applies, in JavaScript: to match file names and to find where on a line
 * the match is. A regex git accepts but JavaScript does not still searches, without a highlight.
 */
function searchMatcher(query: string, options: SearchOptions) {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let pattern: RegExp | null;
  try {
    const source = options.regex ? query : escaped;
    pattern = new RegExp(
      options.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])` : source,
      options.caseSensitive ? 'u' : 'iu',
    );
  } catch {
    pattern = null;
  }
  return {
    test: (text: string) => pattern?.test(text) ?? false,
    locate: (text: string) => {
      const found = pattern?.exec(text);
      return found ? { index: found.index, length: found[0].length } : { index: 0, length: 0 };
    },
  };
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

  /**
   * Searches file names and contents of the whole project with `git grep`, so .gitignore is
   * respected and new files that are not committed yet are included. Binary files are skipped.
   */
  async search(query: string, options: SearchOptions): Promise<SearchResult> {
    const root = this.requireRoot();
    const matcher = searchMatcher(query, options);
    const files = (await this.files())
      .filter((file) => matcher.test(file.split('/').pop() ?? file))
      .slice(0, MAX_NAME_RESULTS);
    const args = ['grep', '-n', '-I', '--null', '--untracked', '--exclude-standard', '--no-color'];
    args.push(options.regex ? '-E' : '-F');
    if (!options.caseSensitive) args.push('-i');
    if (options.wholeWord) args.push('-w');
    args.push('-e', query);
    const result = await git(root, args, { allowFailure: true, timeoutMs: 30_000 });
    // git grep exits with 1 when nothing matches; anything above that is a real failure.
    if (result.code > 1)
      throw new HiveError(
        'VALIDATION',
        options.regex
          ? 'A expressão regular não é válida para a busca.'
          : `A busca falhou: ${result.stderr.trim().slice(0, 300)}`,
      );
    const matches: SearchMatch[] = [];
    let truncated = false;
    for (const row of result.stdout.split('\n')) {
      if (!row) continue;
      if (matches.length >= MAX_CONTENT_RESULTS) {
        truncated = true;
        break;
      }
      // With --null the path ends at a NUL; the line number follows, then ':' and the text.
      const nul = row.indexOf('\0');
      const rest = row.slice(nul + 1);
      const colon = rest.indexOf('\0') >= 0 ? rest.indexOf('\0') : rest.indexOf(':');
      const line = Number(rest.slice(0, colon));
      if (nul < 0 || !Number.isFinite(line)) continue;
      const text = rest.slice(colon + 1).replace(/\r$/, '');
      const found = matcher.locate(text);
      matches.push({
        path: row.slice(0, nul),
        line,
        // Columns are counted in characters here, as the editor counts them.
        column: found.index + 1,
        length: found.length,
        text: text.length > MAX_LINE_CHARS ? text.slice(0, MAX_LINE_CHARS) : text,
      });
    }
    return { files, matches, truncated };
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
