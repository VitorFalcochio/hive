import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { HiveError } from '@hive/shared';
import { git, hiveCommitFlags } from './git';

export interface RepoInfo {
  root: string;
  branch: string | null;
  head: string | null;
}

export interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
}

export interface DiffFile {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
}

export interface DiffResult {
  files: DiffFile[];
  patch: string;
  truncated: boolean;
  insertions: number;
  deletions: number;
}

const HIVE_BRANCH_PREFIX = 'hive/';

/** Inspect a folder and return its repository root, or throw NOT_A_GIT_REPO. */
export async function inspectRepository(folder: string): Promise<RepoInfo> {
  const info = await stat(folder).catch(() => null);
  if (!info?.isDirectory()) throw new HiveError('NOT_FOUND', `Folder not found: ${folder}`);
  const top = await git(folder, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (top.code !== 0) throw new HiveError('NOT_A_GIT_REPO', 'This folder is not inside a Git repository. Run `git init` first.');
  const root = path.resolve(top.stdout.trim());
  const branch = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true });
  const head = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFailure: true });
  return {
    root,
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    head: head.code === 0 ? head.stdout.trim() : null,
  };
}

export async function statusPorcelain(root: string): Promise<{ path: string; status: string }[]> {
  const { stdout } = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  return stdout
    .split('\0')
    .filter(Boolean)
    .map((entry) => ({ status: entry.slice(0, 2).trim(), path: entry.slice(3) }));
}

export async function listWorktrees(root: string): Promise<WorktreeEntry[]> {
  const { stdout } = await git(root, ['worktree', 'list', '--porcelain']);
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: path.resolve(line.slice(9)), head: null, branch: null };
    } else if (current && line.startsWith('HEAD ')) current.head = line.slice(5);
    else if (current && line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  if (current) entries.push(current);
  return entries;
}

export function isHiveBranch(branch: string): boolean {
  return branch.startsWith(HIVE_BRANCH_PREFIX);
}

export function taskBranchName(runId: string, taskKey: string, attempt: number): string {
  const safeKey = taskKey.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'task';
  return `${HIVE_BRANCH_PREFIX}${runId.replace(/^run_/, '').slice(0, 8)}/${safeKey}-a${attempt}`;
}

/**
 * Manages worktrees for one repository under a Hive-owned directory. Only paths inside
 * `worktreeRoot` and branches under `hive/` are ever removed: the user's branches and the
 * main working tree are never modified.
 */
export class WorktreeManager {
  constructor(
    readonly repoRoot: string,
    readonly worktreeRoot: string,
  ) {}

  private assertOwned(target: string): void {
    const relative = path.relative(this.worktreeRoot, path.resolve(target));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new HiveError('FORBIDDEN_PATH', `Refusing to touch a worktree outside Hive's directory: ${target}`);
    }
  }

  async create(name: string, branch: string, startPoint: string): Promise<string> {
    if (!isHiveBranch(branch)) throw new HiveError('GIT', `Task branches must start with ${HIVE_BRANCH_PREFIX}`);
    const target = path.join(this.worktreeRoot, name);
    this.assertOwned(target);
    await mkdir(this.worktreeRoot, { recursive: true });
    await this.remove(target, branch).catch(() => undefined);
    await git(this.repoRoot, ['worktree', 'add', '-b', branch, target, startPoint], { timeoutMs: 180_000 });
    return target;
  }

  async remove(target: string, branch: string | null): Promise<void> {
    this.assertOwned(target);
    await git(this.repoRoot, ['worktree', 'remove', '--force', target], { allowFailure: true });
    await rm(target, { recursive: true, force: true });
    await git(this.repoRoot, ['worktree', 'prune'], { allowFailure: true });
    if (branch && isHiveBranch(branch)) await git(this.repoRoot, ['branch', '-D', branch], { allowFailure: true });
  }

  /**
   * Snapshot everything the agent changed as one commit on the task branch, so the result
   * survives worktree removal and can be diffed or merged by the user. Repository hooks are
   * not run for these internal snapshots; they run when the user integrates the branch.
   */
  async commitAll(worktree: string, message: string): Promise<string | null> {
    this.assertOwned(worktree);
    await git(worktree, ['add', '-A']);
    const staged = await git(worktree, ['diff', '--cached', '--quiet'], { allowFailure: true });
    if (staged.code === 0) return null;
    await git(worktree, [...hiveCommitFlags, 'commit', '--no-verify', '-m', message]);
    return (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim();
  }

  /** Bring a dependency's branch into a task worktree. Conflicts abort the merge and throw. */
  async mergeBranch(worktree: string, branch: string): Promise<void> {
    this.assertOwned(worktree);
    const result = await git(worktree, [...hiveCommitFlags, 'merge', '--no-edit', '--no-ff', branch], { allowFailure: true });
    if (result.code !== 0) {
      await git(worktree, ['merge', '--abort'], { allowFailure: true });
      throw new HiveError('CONFLICT', `Could not merge ${branch} into the task worktree: ${result.stdout || result.stderr}`.trim());
    }
  }

  async headOf(ref: string): Promise<string | null> {
    const result = await git(this.repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFailure: true });
    return result.code === 0 ? result.stdout.trim() : null;
  }
}

/** Diff between two refs (or a ref and a working tree when `cwd` is a worktree and `to` is null). */
export async function diffRefs(cwd: string, from: string, to: string | null, maxPatchBytes = 400_000): Promise<DiffResult> {
  const range = to ? [`${from}`, to] : [from];
  const numstat = await git(cwd, ['diff', '--numstat', '-z', '--find-renames', ...range]);
  const nameStatus = await git(cwd, ['diff', '--name-status', '-z', '--find-renames', ...range]);
  const statuses = new Map<string, string>();
  const parts = nameStatus.stdout.split('\0').filter((part) => part !== '');
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++]!;
    if (status.startsWith('R') || status.startsWith('C')) {
      i++; // old path
      statuses.set(parts[i++]!, status[0]!);
    } else statuses.set(parts[i++]!, status);
  }
  const files: DiffFile[] = [];
  const records = numstat.stdout.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const [added, removed, file] = record.split('\t');
    let filePath = file ?? '';
    if (filePath === '') {
      i++; // rename: old path follows, then new path
      filePath = records[++i] ?? '';
    }
    files.push({
      path: filePath,
      status: statuses.get(filePath) ?? 'M',
      insertions: added === '-' ? 0 : Number(added),
      deletions: removed === '-' ? 0 : Number(removed),
    });
  }
  const patch = await git(cwd, ['diff', '--find-renames', '--no-color', ...range]);
  const truncated = patch.stdout.length > maxPatchBytes;
  return {
    files,
    patch: truncated ? patch.stdout.slice(0, maxPatchBytes) : patch.stdout,
    truncated,
    insertions: files.reduce((sum, file) => sum + file.insertions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}
