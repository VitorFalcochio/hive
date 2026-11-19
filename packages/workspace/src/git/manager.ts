import { randomUUID } from 'node:crypto';
import { access, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { HiveError, errorMessage, secretRedactor } from '@hive/shared';
import { git, type GitResult } from '../git';
import {
  DEFAULT_PROTECTED,
  defaultGitPolicy,
  needsApproval,
  type GitActor,
  type GitOperationKind,
  type GitPolicy,
} from './policy';
import {
  SAFE_GIT_CONFIG,
  assertBranchName,
  assertCommitId,
  assertCommitMessage,
  assertRemoteName,
  assertRemoteUrl,
  literalPathspecs,
  repoRelativePath,
} from './validate';

const LOCAL_TIMEOUT_MS = 60_000;
const NETWORK_TIMEOUT_MS = 5 * 60_000;
const CLONE_TIMEOUT_MS = 15 * 60_000;

/* ------------------------------------------------------------------ public shapes */

export interface GitFileStatus {
  path: string;
  /** Former path of a rename or copy. */
  from?: string;
  /** Porcelain v2 codes: index (staged) and worktree sides, "." for unchanged. */
  index: string;
  worktree: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export interface GitStatus {
  root: string;
  branch: string | null;
  detached: boolean;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** A merge stopped on conflicts (MERGE_HEAD) or a rebase is in progress. */
  merging: boolean;
  rebasing: boolean;
  files: GitFileStatus[];
}

export interface GitCommit {
  hash: string;
  short: string;
  author: string;
  email: string;
  date: string;
  parents: string[];
  subject: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** The upstream branch was deleted on the remote. */
  gone: boolean;
}

/** One entry of the audit trail: what was asked, by whom, and how it ended. Never content. */
export interface GitAuditEntry {
  id: string;
  at: string;
  op: string;
  kind: GitOperationKind;
  repo: string;
  actor: GitActor;
  approval: 'not-needed' | 'approved' | 'denied';
  outcome: 'ok' | 'error' | 'cancelled';
  durationMs: number;
  detail: Record<string, unknown>;
  error?: string;
}

export interface GitApprovalRequest {
  op: string;
  kind: GitOperationKind;
  repo: string;
  actor: GitActor;
  /** What will happen, in the words the approval dialog shows. */
  summary: string;
  detail: Record<string, unknown>;
}

export interface GitManagerOptions {
  /** Asked before destructive and publishing operations (and agents' writes to protected branches). */
  approve: (request: GitApprovalRequest) => Promise<boolean>;
  /** Receives every operation that changes something or reaches a remote, redacted. */
  audit?: (entry: GitAuditEntry) => void;
  policy?: Partial<GitPolicy>;
  /**
   * Extra environment for operations that reach a remote, e.g. a credential header built in
   * the main process. Called per operation, so a fresh token is used each time.
   */
  remoteEnv?: (repo: string, remote: string) => Promise<Record<string, string>>;
}

export interface OperationOptions {
  actor?: GitActor;
  signal?: AbortSignal;
}

const USER: GitActor = { kind: 'user' };

/* ------------------------------------------------------------------ errors */

/** Turns git's own failure text into an error the user can act on, without secrets. */
export function classifyGitFailure(op: string, output: string): HiveError {
  const text = secretRedactor.redact(output.trim()).slice(0, 1_500);
  const detail = text ? ` ${text}` : '';
  if (
    /authentication failed|could not read (username|password)|terminal prompts disabled|invalid username or password|permission denied \(publickey|access denied|returned error: 40[13]|HTTP 40[13]|bad credentials/i.test(
      text,
    )
  )
    return new HiveError(
      'AUTH',
      `O remote recusou as credenciais (${op}). Conecte a conta de novo.${detail}`,
    );
  if (/GH006|protected branch|pre-receive hook declined/i.test(text))
    return new HiveError('DENIED', `O remote protege essa branch (${op}).${detail}`);
  if (
    /could not resolve host|failed to connect|connection (refused|timed out|reset)|network is unreachable|operation timed out|unable to access|bsslb|btlsb|early eof|rpc failed|could not read from remote/i.test(
      text,
    )
  )
    return new HiveError('NETWORK', `Não foi possível falar com o remote (${op}).${detail}`);
  if (/non-fast-forward|fetch first|\[rejected\]|not possible to fast-forward|diverg/i.test(text))
    return new HiveError(
      'CONFLICT',
      `A branch local e a remota divergiram (${op}). Atualize com pull antes.${detail}`,
    );
  return new HiveError('GIT', `git ${op} falhou.${detail}`);
}

/* ------------------------------------------------------------------ the manager */

/**
 * The one place Hive changes Git repositories: the user's actions in the interface and the
 * agents' requests come through here. It validates every argument, asks for approval by the
 * policy, runs one changing operation at a time per repository (worktrees of a repository
 * share it), can be cancelled, and leaves an audit entry for everything but reads.
 */
export class GitManager {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly commonDirs = new Map<string, string>();
  private readonly policy: GitPolicy;

  constructor(private readonly options: GitManagerOptions) {
    this.policy = { ...defaultGitPolicy, ...options.policy };
  }

  /* ------------------------------------------------------------ plumbing */

  private async run(
    root: string,
    args: string[],
    options: { signal?: AbortSignal; timeoutMs?: number; env?: Record<string, string> } = {},
  ): Promise<GitResult> {
    return git(root, [...SAFE_GIT_CONFIG, ...args], {
      allowFailure: true,
      timeoutMs: options.timeoutMs ?? LOCAL_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
  }

  private async ok(
    root: string,
    op: string,
    args: string[],
    options: { signal?: AbortSignal; timeoutMs?: number; env?: Record<string, string> } = {},
  ): Promise<string> {
    const result = await this.run(root, args, options);
    if (result.code !== 0) throw classifyGitFailure(op, result.stderr || result.stdout);
    return result.stdout;
  }

  /** The repository a folder belongs to; worktrees of one repository share its key. */
  private async repoKey(root: string): Promise<string> {
    const known = this.commonDirs.get(root);
    if (known) return known;
    const out = await this.run(root, ['rev-parse', '--git-common-dir']);
    if (out.code !== 0)
      throw new HiveError('NOT_A_GIT_REPO', 'Esta pasta não está num repositório Git.');
    const resolved = path.resolve(root, out.stdout.trim());
    // Windows paths differ only in case for the same folder; elsewhere case matters.
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    this.commonDirs.set(root, key);
    return key;
  }

  /** Runs `task` after every earlier changing operation of the same repository. */
  private async serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
    const before = this.queues.get(key) ?? Promise.resolve();
    const current = before.catch(() => undefined).then(task);
    const tail = current.catch(() => undefined);
    this.queues.set(key, tail);
    try {
      return await current;
    } finally {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    }
  }

  /**
   * One changing operation: approval when the policy asks for it, then the work in the
   * repository's queue, then an audit entry however it ended. A cancelled operation that left
   * git's index lock behind has it removed, since the process that held it was ours and is gone.
   */
  private async operation<T>(
    root: string,
    spec: {
      op: string;
      kind: GitOperationKind;
      summary: string;
      detail?: Record<string, unknown>;
      /** The branch it changes, for the protected-branch rule. */
      branch?: string | null;
    },
    options: OperationOptions,
    work: () => Promise<T>,
  ): Promise<T> {
    const actor = options.actor ?? USER;
    const detail = spec.detail ?? {};
    const started = Date.now();
    const key = await this.repoKey(root);
    const onProtected = spec.branch ? await this.isProtected(root, spec.branch) : false;
    const audit = (
      outcome: GitAuditEntry['outcome'],
      approval: GitAuditEntry['approval'],
      error?: string,
    ) =>
      this.options.audit?.(
        secretRedactor.redactDeep({
          id: randomUUID(),
          at: new Date().toISOString(),
          op: spec.op,
          kind: spec.kind,
          repo: root,
          actor,
          approval,
          outcome,
          durationMs: Date.now() - started,
          detail,
          ...(error ? { error } : {}),
        }),
      );
    let approval: GitAuditEntry['approval'] = 'not-needed';
    if (needsApproval(this.policy, spec.kind, actor, onProtected)) {
      const approved = await this.options.approve({
        op: spec.op,
        kind: spec.kind,
        repo: root,
        actor,
        summary: spec.summary,
        detail,
      });
      approval = approved ? 'approved' : 'denied';
      if (!approved) {
        audit('error', approval, 'Não aprovado.');
        throw new HiveError('DENIED', `Operação não aprovada: ${spec.summary}`);
      }
    }
    // A worktree has its own index, in its own git folder.
    const index = await this.run(root, ['rev-parse', '--git-path', 'index']);
    const lock = index.code === 0 ? `${path.resolve(root, index.stdout.trim())}.lock` : null;
    return this.serialized(key, async () => {
      try {
        if (options.signal?.aborted) throw new HiveError('CANCELLED', 'Operação Git cancelada.');
        const result = await work();
        audit('ok', approval);
        return result;
      } catch (error) {
        const cancelled = error instanceof HiveError && error.code === 'CANCELLED';
        if (cancelled && lock) {
          const info = await stat(lock).catch(() => null);
          if (info && info.mtimeMs >= started - 1_000) await rm(lock, { force: true });
        }
        audit(
          cancelled ? 'cancelled' : 'error',
          approval,
          secretRedactor.redact(errorMessage(error)),
        );
        throw error;
      }
    });
  }

  /** main, master, the remote's default branch and the policy's own list. */
  async protectedBranches(root: string): Promise<string[]> {
    const names = new Set([...DEFAULT_PROTECTED, ...this.policy.protectedBranches]);
    const head = await this.run(root, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'refs/remotes/origin/HEAD',
    ]);
    if (head.code === 0) {
      const name = head.stdout.trim().replace(/^origin\//, '');
      if (name) names.add(name);
    }
    return [...names];
  }

  private async isProtected(root: string, branch: string): Promise<boolean> {
    return (await this.protectedBranches(root)).includes(branch);
  }

  private async currentBranch(root: string): Promise<string | null> {
    const out = await this.run(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return out.code === 0 ? out.stdout.trim() : null;
  }

  private async hasHead(root: string): Promise<boolean> {
    return (await this.run(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code === 0;
  }

  /* ------------------------------------------------------------ repositories */

  /** The repository root of a folder, or null when it is not in one. */
  async detect(folder: string): Promise<string | null> {
    const info = await stat(folder).catch(() => null);
    if (!info?.isDirectory()) return null;
    const out = await this.run(folder, ['rev-parse', '--show-toplevel']);
    return out.code === 0 ? path.resolve(out.stdout.trim()) : null;
  }

  async init(
    folder: string,
    options: OperationOptions & { initialBranch?: string } = {},
  ): Promise<string> {
    const info = await stat(folder).catch(() => null);
    if (!info?.isDirectory()) throw new HiveError('NOT_FOUND', `Pasta não encontrada: ${folder}`);
    const existing = await this.detect(folder);
    if (existing && path.resolve(existing).toLowerCase() === path.resolve(folder).toLowerCase())
      throw new HiveError('CONFLICT', 'Esta pasta já é um repositório Git.');
    const branch = assertBranchName(options.initialBranch ?? 'main');
    await this.ok(folder, 'init', ['init', '-q', '-b', branch]);
    this.options.audit?.({
      id: randomUUID(),
      at: new Date().toISOString(),
      op: 'init',
      kind: 'write',
      repo: folder,
      actor: options.actor ?? USER,
      approval: 'not-needed',
      outcome: 'ok',
      durationMs: 0,
      detail: { branch },
    });
    return path.resolve(folder);
  }

  /**
   * Clones into `parent/name`. The folder must not exist yet; a clone that fails or is
   * cancelled leaves nothing behind.
   */
  async clone(
    url: string,
    parent: string,
    name: string,
    options: OperationOptions & { env?: Record<string, string> } = {},
  ): Promise<string> {
    const remote = assertRemoteUrl(url);
    if (
      // A single folder name, valid on Windows too: no separators, reserved or control characters.
      // eslint-disable-next-line no-control-regex
      !/^[^\\/:*?"<>|\u0000-\u001f]{1,200}$/.test(name) ||
      name === '.' ||
      name === '..' ||
      name.startsWith('-')
    )
      throw new HiveError('VALIDATION', `Nome de pasta inválido: "${name.slice(0, 80)}".`);
    const info = await stat(parent).catch(() => null);
    if (!info?.isDirectory()) throw new HiveError('NOT_FOUND', `Pasta não encontrada: ${parent}`);
    const target = path.join(parent, name);
    if (
      await access(target).then(
        () => true,
        () => false,
      )
    )
      throw new HiveError('CONFLICT', `Já existe uma pasta com esse nome: ${name}`);
    const started = Date.now();
    const actor = options.actor ?? USER;
    try {
      await this.ok(parent, 'clone', ['clone', '--origin', 'origin', '--', remote, target], {
        timeoutMs: CLONE_TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.env ? { env: options.env } : {}),
      });
    } catch (error) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
      this.options.audit?.(
        secretRedactor.redactDeep({
          id: randomUUID(),
          at: new Date().toISOString(),
          op: 'clone',
          kind: 'write' as const,
          repo: target,
          actor,
          approval: 'not-needed' as const,
          outcome:
            error instanceof HiveError && error.code === 'CANCELLED'
              ? ('cancelled' as const)
              : ('error' as const),
          durationMs: Date.now() - started,
          detail: { url: remote },
          error: errorMessage(error),
        }),
      );
      throw error;
    }
    this.options.audit?.(
      secretRedactor.redactDeep({
        id: randomUUID(),
        at: new Date().toISOString(),
        op: 'clone',
        kind: 'write' as const,
        repo: target,
        actor,
        approval: 'not-needed' as const,
        outcome: 'ok' as const,
        durationMs: Date.now() - started,
        detail: { url: remote },
      }),
    );
    return target;
  }

  /* ------------------------------------------------------------ reading */

  async status(root: string, options: OperationOptions = {}): Promise<GitStatus> {
    const out = await this.ok(
      root,
      'status',
      [
        '--no-optional-locks',
        'status',
        '--porcelain=v2',
        '--branch',
        '-z',
        '--untracked-files=all',
      ],
      options,
    );
    const status: GitStatus = {
      root,
      branch: null,
      detached: false,
      head: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      merging: false,
      rebasing: false,
      files: [],
    };
    const records = out.split('\0');
    for (let index = 0; index < records.length; index++) {
      const record = records[index]!;
      if (!record) continue;
      if (record.startsWith('# ')) {
        const [, key, ...rest] = record.split(' ');
        const value = rest.join(' ');
        if (key === 'branch.oid') status.head = value === '(initial)' ? null : value;
        else if (key === 'branch.head') {
          status.detached = value === '(detached)';
          status.branch = status.detached ? null : value;
        } else if (key === 'branch.upstream') status.upstream = value;
        else if (key === 'branch.ab') {
          const match = /^\+(\d+) -(\d+)$/.exec(value);
          if (match) {
            status.ahead = Number(match[1]);
            status.behind = Number(match[2]);
          }
        }
        continue;
      }
      const type = record[0];
      const fields = (count: number) => {
        const parts = record.split(' ');
        return { head: parts.slice(0, count), path: parts.slice(count).join(' ') };
      };
      if (type === '?') {
        status.files.push(file(record.slice(2), '?', '?', { untracked: true }));
      } else if (type === '1') {
        const { head, path: name } = fields(8);
        const xy = head[1]!;
        status.files.push(file(name, xy[0]!, xy[1]!));
      } else if (type === '2') {
        const { head, path: name } = fields(9);
        const xy = head[1]!;
        const from = records[++index] ?? '';
        status.files.push({ ...file(name, xy[0]!, xy[1]!), from });
      } else if (type === 'u') {
        const { head, path: name } = fields(10);
        const xy = head[1]!;
        status.files.push(file(name, xy[0]!, xy[1]!, { conflicted: true }));
      }
    }
    const gitPath = async (name: string) => {
      const result = await this.run(root, ['rev-parse', '--git-path', name]);
      return result.code === 0 ? path.resolve(root, result.stdout.trim()) : null;
    };
    const exists = async (target: string | null) =>
      !!target &&
      (await access(target).then(
        () => true,
        () => false,
      ));
    status.merging = await exists(await gitPath('MERGE_HEAD'));
    status.rebasing =
      (await exists(await gitPath('rebase-merge'))) ||
      (await exists(await gitPath('rebase-apply')));
    return status;
  }

  /** The patch of one file: what is staged, or what is not yet staged. */
  async diff(
    root: string,
    file: string,
    options: OperationOptions & { staged?: boolean } = {},
  ): Promise<string> {
    const specs = literalPathspecs([file]);
    return this.ok(
      root,
      'diff',
      [
        '--no-optional-locks',
        'diff',
        '--no-color',
        '--no-ext-diff',
        ...(options.staged ? ['--cached'] : []),
        ...specs,
      ],
      options,
    );
  }

  async log(
    root: string,
    options: OperationOptions & { limit?: number; ref?: string; file?: string } = {},
  ): Promise<GitCommit[]> {
    if (!(await this.hasHead(root))) return [];
    const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 50)), 500);
    const ref = options.ref ? refOrCommit(options.ref) : 'HEAD';
    const out = await this.ok(
      root,
      'log',
      [
        'log',
        `--max-count=${limit}`,
        '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%s%x1e',
        ref,
        ...(options.file ? literalPathspecs([options.file]) : ['--']),
      ],
      options,
    );
    return out
      .split('\x1e')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [hash, short, author, email, date, parents, subject] = entry.split('\x1f');
        return {
          hash: hash!,
          short: short!,
          author: author!,
          email: email!,
          date: date!,
          parents: parents ? parents.split(' ').filter(Boolean) : [],
          subject: subject ?? '',
        };
      });
  }

  async branches(
    root: string,
    options: OperationOptions = {},
  ): Promise<{ local: GitBranch[]; remote: string[] }> {
    const local = await this.ok(
      root,
      'branch',
      [
        'for-each-ref',
        '--format=%(refname:short)%1f%(HEAD)%1f%(upstream:short)%1f%(upstream:track)',
        'refs/heads',
      ],
      options,
    );
    const remote = await this.ok(
      root,
      'branch',
      ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'],
      options,
    );
    return {
      local: local
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [name, head, upstream, track] = line.split('\x1f');
          return {
            name: name!,
            current: head === '*',
            upstream: upstream || null,
            ahead: Number(/ahead (\d+)/.exec(track ?? '')?.[1] ?? 0),
            behind: Number(/behind (\d+)/.exec(track ?? '')?.[1] ?? 0),
            gone: (track ?? '').includes('gone'),
          };
        }),
      remote: remote
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.endsWith('/HEAD')),
    };
  }

  async remotes(root: string): Promise<{ name: string; url: string }[]> {
    const out = await this.ok(root, 'remote', ['remote', '-v']);
    const seen = new Map<string, string>();
    for (const line of out.split('\n')) {
      const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
      if (match) seen.set(match[1]!, secretRedactor.redact(match[2]!));
    }
    return [...seen].map(([name, url]) => ({ name, url }));
  }

  /* ------------------------------------------------------------ branches */

  async createBranch(
    root: string,
    name: string,
    options: OperationOptions & { from?: string; switchTo?: boolean } = {},
  ): Promise<void> {
    const branch = assertBranchName(name);
    const from = options.from ? refOrCommit(options.from) : null;
    await this.operation(
      root,
      {
        op: 'branch.create',
        kind: 'write',
        summary: `Criar a branch ${branch}`,
        detail: { branch, from },
      },
      options,
      async () => {
        if (options.switchTo) {
          await this.assertCleanForSwitch(root);
          await this.ok(root, 'switch', ['switch', '-c', branch, ...(from ? [from] : [])], options);
        } else await this.ok(root, 'branch', ['branch', branch, ...(from ? [from] : [])], options);
      },
    );
  }

  async checkout(root: string, name: string, options: OperationOptions = {}): Promise<void> {
    const branch = assertBranchName(name);
    await this.operation(
      root,
      {
        op: 'checkout',
        kind: 'write',
        summary: `Trocar para a branch ${branch}`,
        detail: { branch },
      },
      options,
      async () => {
        await this.assertCleanForSwitch(root);
        await this.ok(root, 'switch', ['switch', branch], options);
      },
    );
  }

  private async assertCleanForSwitch(root: string): Promise<void> {
    const status = await this.status(root);
    const changed = status.files.filter((file) => !file.untracked);
    if (status.merging || status.rebasing)
      throw new HiveError(
        'CONFLICT',
        'Há um merge ou rebase em andamento. Termine ou aborte antes.',
      );
    if (changed.length)
      throw new HiveError(
        'CONFLICT',
        `Há ${changed.length} arquivo(s) com alterações não commitadas. Faça commit ou descarte antes de trocar de branch.`,
      );
  }

  /**
   * Deletes a local branch. The current branch and protected ones are never deleted. A branch
   * whose work is not merged anywhere is deleted only with approval.
   */
  async deleteBranch(root: string, name: string, options: OperationOptions = {}): Promise<void> {
    const branch = assertBranchName(name);
    if ((await this.currentBranch(root)) === branch)
      throw new HiveError(
        'CONFLICT',
        'Não dá para excluir a branch em uso. Troque de branch antes.',
      );
    if (await this.isProtected(root, branch))
      throw new HiveError('DENIED', `A branch ${branch} é protegida e não é excluída pelo Hive.`);
    const known = await this.run(root, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ]);
    if (known.code !== 0) throw new HiveError('NOT_FOUND', `Branch não encontrada: ${branch}`);
    const merged = await this.run(root, [
      'merge-base',
      '--is-ancestor',
      `refs/heads/${branch}`,
      'HEAD',
    ]);
    const kind: GitOperationKind = merged.code === 0 ? 'write' : 'destructive';
    await this.operation(
      root,
      {
        op: 'branch.delete',
        kind,
        summary:
          kind === 'write'
            ? `Excluir a branch ${branch} (já integrada)`
            : `Excluir a branch ${branch}, com commits que não estão em nenhuma outra branch`,
        detail: { branch, merged: kind === 'write' },
      },
      options,
      async () => {
        await this.ok(root, 'branch', ['branch', kind === 'write' ? '-d' : '-D', branch], options);
      },
    );
  }

  /* ------------------------------------------------------------ changes */

  /** Stages exactly these files, nothing else. */
  async stage(root: string, files: string[], options: OperationOptions = {}): Promise<void> {
    const specs = literalPathspecs(files);
    await this.operation(
      root,
      {
        op: 'stage',
        kind: 'write',
        summary: `Preparar ${specs.length - 1} arquivo(s)`,
        detail: { files: specs.length - 1 },
      },
      options,
      async () => void (await this.ok(root, 'add', ['add', '--all', ...specs], options)),
    );
  }

  async unstage(root: string, files: string[], options: OperationOptions = {}): Promise<void> {
    const specs = literalPathspecs(files);
    await this.operation(
      root,
      {
        op: 'unstage',
        kind: 'write',
        summary: `Tirar ${specs.length - 1} arquivo(s) do stage`,
        detail: { files: specs.length - 1 },
      },
      options,
      async () => {
        if (await this.hasHead(root))
          await this.ok(root, 'restore', ['restore', '--staged', ...specs], options);
        else await this.ok(root, 'rm', ['rm', '--cached', '-q', '-r', ...specs], options);
      },
    );
  }

  /**
   * Throws away the uncommitted changes of these tracked files, staged or not. New files that
   * were never committed are not deleted from here: that goes through the recycle bin.
   */
  async discard(root: string, files: string[], options: OperationOptions = {}): Promise<void> {
    const specs = literalPathspecs(files);
    const wanted = new Set(files.map(repoRelativePath));
    const status = await this.status(root);
    const untracked = status.files.filter((file) => file.untracked && wanted.has(file.path));
    if (untracked.length)
      throw new HiveError(
        'VALIDATION',
        `Arquivo novo, nunca commitado: ${untracked[0]!.path}. Para apagá-lo, use a lixeira no explorador.`,
      );
    if (!status.head) throw new HiveError('CONFLICT', 'O repositório ainda não tem commits.');
    await this.operation(
      root,
      {
        op: 'discard',
        kind: 'destructive',
        summary: `Descartar as alterações de ${wanted.size} arquivo(s); não dá para desfazer`,
        detail: { files: [...wanted].slice(0, 50) },
        branch: status.branch,
      },
      options,
      async () =>
        void (await this.ok(
          root,
          'restore',
          ['restore', '--source=HEAD', '--staged', '--worktree', ...specs],
          options,
        )),
    );
  }

  /**
   * Commits what is staged, with the repository's own identity and hooks. Refused while
   * conflicts are unresolved or when nothing is staged.
   */
  async commit(root: string, message: string, options: OperationOptions = {}): Promise<string> {
    const text = assertCommitMessage(message);
    const status = await this.status(root);
    const conflicts = status.files.filter((file) => file.conflicted);
    if (conflicts.length)
      throw new HiveError(
        'CONFLICT',
        `Resolva os ${conflicts.length} conflito(s) antes do commit.`,
      );
    if (!status.merging && !status.files.some((file) => file.staged))
      throw new HiveError(
        'VALIDATION',
        'Nada preparado para o commit. Escolha os arquivos primeiro.',
      );
    const email = await this.run(root, ['config', 'user.email']);
    if (email.code !== 0 || !email.stdout.trim())
      throw new HiveError(
        'VALIDATION',
        'Configure seu nome e e-mail do Git antes do commit (git config user.name e user.email).',
      );
    return this.operation(
      root,
      {
        op: 'commit',
        kind: 'write',
        summary: `Commit em ${status.branch ?? 'HEAD desanexado'}: ${text.split('\n')[0]!.slice(0, 120)}`,
        detail: { branch: status.branch, files: status.files.filter((file) => file.staged).length },
        branch: status.branch,
      },
      options,
      async () => {
        await this.ok(root, 'commit', ['commit', '--quiet', '-m', text], options);
        return (await this.ok(root, 'rev-parse', ['rev-parse', 'HEAD'])).trim();
      },
    );
  }

  /* ------------------------------------------------------------ remotes */

  async addRemote(
    root: string,
    name: string,
    url: string,
    options: OperationOptions = {},
  ): Promise<void> {
    const remote = assertRemoteName(name);
    const target = assertRemoteUrl(url);
    await this.operation(
      root,
      {
        op: 'remote.add',
        kind: 'write',
        summary: `Ligar o remote ${remote}`,
        detail: { remote, url: target },
      },
      options,
      async () => void (await this.ok(root, 'remote', ['remote', 'add', remote, target], options)),
    );
  }

  async fetch(root: string, options: OperationOptions & { remote?: string } = {}): Promise<void> {
    const remote = assertRemoteName(options.remote ?? 'origin');
    await this.operation(
      root,
      { op: 'fetch', kind: 'write', summary: `Buscar novidades de ${remote}`, detail: { remote } },
      options,
      async () => {
        const env = (await this.options.remoteEnv?.(root, remote)) ?? {};
        await this.ok(root, 'fetch', ['fetch', '--prune', '--no-recurse-submodules', remote], {
          ...options,
          env,
          timeoutMs: NETWORK_TIMEOUT_MS,
        });
      },
    );
  }

  /**
   * Brings the upstream's commits into the current branch. By default only a fast-forward:
   * when the branches diverged it stops and says so. With `merge`, it merges and, on conflicts,
   * returns them (the merge stays in progress for the user to resolve or abort).
   */
  async pull(
    root: string,
    options: OperationOptions & { merge?: boolean } = {},
  ): Promise<{ conflicts: string[] }> {
    const status = await this.status(root);
    if (!status.branch) throw new HiveError('CONFLICT', 'Não há branch atual (HEAD desanexado).');
    if (!status.upstream)
      throw new HiveError(
        'CONFLICT',
        `A branch ${status.branch} não acompanha nenhuma branch remota.`,
      );
    const remote = assertRemoteName(status.upstream.split('/')[0]!);
    return this.operation(
      root,
      {
        op: options.merge ? 'pull.merge' : 'pull',
        kind: 'write',
        summary: `Atualizar ${status.branch} a partir de ${status.upstream}`,
        detail: { branch: status.branch, upstream: status.upstream, merge: !!options.merge },
        branch: status.branch,
      },
      options,
      async () => {
        const env = (await this.options.remoteEnv?.(root, remote)) ?? {};
        const result = await this.run(
          root,
          [
            'pull',
            '--no-recurse-submodules',
            ...(options.merge ? ['--no-rebase', '--no-edit'] : ['--ff-only']),
          ],
          { ...options, env, timeoutMs: NETWORK_TIMEOUT_MS },
        );
        if (result.code === 0) return { conflicts: [] };
        if (options.merge) {
          const after = await this.status(root);
          const conflicts = after.files.filter((file) => file.conflicted).map((file) => file.path);
          if (after.merging && conflicts.length) return { conflicts };
        }
        throw classifyGitFailure('pull', result.stderr || result.stdout);
      },
    );
  }

  /** Sends the current (or given) branch to its remote. Never forced; always approved. */
  async push(
    root: string,
    options: OperationOptions & { remote?: string; branch?: string; setUpstream?: boolean } = {},
  ): Promise<void> {
    const remote = assertRemoteName(options.remote ?? 'origin');
    const branch = assertBranchName(options.branch ?? (await this.currentBranch(root)) ?? '');
    const known = await this.run(root, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ]);
    if (known.code !== 0) throw new HiveError('NOT_FOUND', `Branch não encontrada: ${branch}`);
    const ahead = await this.run(root, [
      'rev-list',
      '--count',
      `refs/remotes/${remote}/${branch}..refs/heads/${branch}`,
    ]);
    const commits = ahead.code === 0 ? Number(ahead.stdout.trim()) : null;
    await this.operation(
      root,
      {
        op: 'push',
        kind: 'publish',
        summary:
          commits === null
            ? `Publicar a branch nova ${branch} em ${remote}`
            : `Publicar ${commits} commit(s) de ${branch} em ${remote}`,
        detail: { remote, branch, commits },
        branch,
      },
      options,
      async () => {
        const env = (await this.options.remoteEnv?.(root, remote)) ?? {};
        await this.ok(
          root,
          'push',
          [
            'push',
            '--no-recurse-submodules',
            ...(options.setUpstream ? ['--set-upstream'] : []),
            remote,
            `refs/heads/${branch}:refs/heads/${branch}`,
          ],
          { ...options, env, timeoutMs: NETWORK_TIMEOUT_MS },
        );
      },
    );
  }

  /* ------------------------------------------------------------ conflicts */

  async conflicts(root: string): Promise<string[]> {
    return (await this.status(root)).files
      .filter((file) => file.conflicted)
      .map((file) => file.path);
  }

  /** Gives up the merge in progress and puts the files back as they were before it. */
  async abortMerge(root: string, options: OperationOptions = {}): Promise<void> {
    const status = await this.status(root);
    if (!status.merging) throw new HiveError('CONFLICT', 'Não há merge em andamento.');
    await this.operation(
      root,
      {
        op: 'merge.abort',
        kind: 'destructive',
        summary: 'Abortar o merge em andamento; as resoluções feitas até aqui se perdem',
        branch: status.branch,
      },
      options,
      async () => void (await this.ok(root, 'merge', ['merge', '--abort'], options)),
    );
  }

  /**
   * Resolves one conflicted file: "manual" stages it as the user left it (refused while it still
   * has conflict markers); "ours" or "theirs" replaces it with one side, which needs approval.
   */
  async resolve(
    root: string,
    file: string,
    choice: 'manual' | 'ours' | 'theirs',
    options: OperationOptions = {},
  ): Promise<void> {
    const rel = repoRelativePath(file);
    const specs = literalPathspecs([rel]);
    const status = await this.status(root);
    if (!status.files.some((entry) => entry.conflicted && entry.path === rel))
      throw new HiveError('NOT_FOUND', `Este arquivo não está em conflito: ${rel}`);
    if (choice === 'manual') {
      const text = await readFile(path.join(root, rel), 'utf8').catch(() => '');
      if (/^(<{7}|>{7})( |$)/m.test(text))
        throw new HiveError(
          'CONFLICT',
          `${rel} ainda tem marcas de conflito (<<<<<<< ou >>>>>>>).`,
        );
    }
    await this.operation(
      root,
      {
        op: `resolve.${choice}`,
        kind: choice === 'manual' ? 'write' : 'destructive',
        summary:
          choice === 'manual'
            ? `Marcar ${rel} como resolvido`
            : `Resolver ${rel} ficando com a versão ${choice === 'ours' ? 'local (ours)' : 'que chega (theirs)'}`,
        detail: { file: rel, choice },
        branch: status.branch,
      },
      options,
      async () => {
        if (choice !== 'manual')
          await this.ok(root, 'checkout', ['checkout', `--${choice}`, ...specs], options);
        await this.ok(root, 'add', ['add', ...specs], options);
      },
    );
  }
}

function file(
  name: string,
  index: string,
  worktree: string,
  flags: { untracked?: boolean; conflicted?: boolean } = {},
): GitFileStatus {
  const untracked = !!flags.untracked;
  const conflicted = !!flags.conflicted;
  return {
    path: name,
    index: untracked ? '?' : index,
    worktree: untracked ? '?' : worktree,
    staged: !untracked && !conflicted && index !== '.',
    unstaged: untracked || conflicted || worktree !== '.',
    untracked,
    conflicted,
  };
}

/** A branch, remote-tracking branch or commit id, never anything git could read as an option. */
function refOrCommit(ref: string): string {
  const value = typeof ref === 'string' ? ref.trim() : '';
  if (/^[0-9a-f]{7,64}$/i.test(value)) return assertCommitId(value);
  return assertBranchName(value);
}
