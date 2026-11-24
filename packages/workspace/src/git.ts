import { execFile, spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { HiveError, clipText, errorMessage } from '@hive/shared';

/** Most git output read into memory at once; bounded reads use `gitCapped` instead. */
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

function gitEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_PAGER: 'cat',
    GCM_INTERACTIVE: 'never',
    LC_ALL: 'C',
    ...extra,
  };
}

/**
 * The message of a failed git call. Bounded: stdout can be the whole output (a diff of tens of
 * megabytes), and it once went into an error, then into the database and the UI, freezing both.
 */
function failureMessage(args: string[], error: unknown, stdout: string, stderr: string): string {
  if ((error as NodeJS.ErrnoException | null)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
    return `git ${args[0]} produziu mais de ${MAX_GIT_OUTPUT / 1024 / 1024} MB de saída e foi interrompido. Isso costuma indicar arquivos gerados ou dependências (node_modules, dist) entrando no Git.`;
  const detail = (stderr.trim() || stdout.trim() || errorMessage(error)).trim();
  return `git ${args[0]} failed: ${clipText(detail, 4_000)}`;
}

/** What a missing git says, everywhere Hive calls it. */
export const GIT_MISSING =
  'O Git não está instalado ou não está no PATH. O Hive precisa dele para dar a cada agente a própria cópia do projeto. Instale o Git (git-scm.com/downloads), reinicie o Hive e tente de novo.';

/**
 * Whether a failure comes from the computer rather than the work: git missing, or the project
 * folder not being a usable repository. Trying again, or asking the Queen for another plan,
 * cannot fix it; only the user can.
 */
export function isEnvironmentFailure(text: string | null | undefined): boolean {
  if (!text) return false;
  return (
    text.includes(GIT_MISSING) ||
    /git is not installed|not a git repository|não é um repositório git|ainda não tem nenhum commit/i.test(
      text,
    )
  );
}

/**
 * What stops a mission from running in `repoPath`, in words the user can act on; null when git
 * is installed and the folder is a repository with at least one commit (task worktrees branch
 * from it). Checked before planning and before starting, so nothing is spent on a mission that
 * cannot run.
 */
export async function gitPreflight(repoPath: string): Promise<string | null> {
  // A folder that is gone fails like a missing git (ENOENT), so it is told apart first.
  const folder = await stat(repoPath).catch(() => null);
  if (!folder?.isDirectory())
    return `A pasta do projeto não existe mais (${repoPath}). Abra o projeto de novo pelo Hive.`;
  try {
    await git(repoPath, ['--version'], { timeoutMs: 15_000 });
  } catch (error) {
    if (error instanceof HiveError && error.message === GIT_MISSING) return GIT_MISSING;
    return `Não foi possível rodar o Git na pasta do projeto (${repoPath}): ${errorMessage(error)}`;
  }
  // The folder must be the repository itself, not a folder inside another one: otherwise the
  // agents' copies would be made from (and merged into) the repository around it.
  const top = await git(repoPath, ['rev-parse', '--show-toplevel'], {
    allowFailure: true,
    timeoutMs: 15_000,
  });
  if (top.code !== 0 || !(await samePath(top.stdout.trim(), repoPath)))
    return `A pasta do projeto (${repoPath}) não é um repositório Git. Abra-a pelo Hive para ele preparar o repositório, ou rode "git init" e faça um primeiro commit.`;
  const head = await git(repoPath, ['rev-parse', '--verify', 'HEAD'], {
    allowFailure: true,
    timeoutMs: 15_000,
  });
  if (head.code !== 0)
    return 'O repositório do projeto ainda não tem nenhum commit. Os agentes trabalham em cópias criadas a partir dele: faça um primeiro commit (pode ser só um README) e tente de novo.';
  return null;
}

/** Whether two paths are the same folder, past links, short names and letter case on Windows. */
async function samePath(a: string, b: string): Promise<boolean> {
  const real = (value: string) => realpath(path.resolve(value)).catch(() => path.resolve(value));
  const [left, right] = await Promise.all([real(a), real(b)]);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Runs git without a shell. Never prompts (credential helpers, editors, pagers are disabled),
 * so a misconfigured repository fails fast instead of hanging a worker.
 */
export function git(
  cwd: string,
  args: string[],
  options: {
    timeoutMs?: number;
    allowFailure?: boolean;
    /** Stops the process; the promise then rejects with CANCELLED. */
    signal?: AbortSignal;
    /**
     * Extra environment for this one process only, e.g. credentials for a push. Never put on
     * the command line, where other processes and error messages could show it.
     */
    env?: Record<string, string>;
  } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new HiveError('CANCELLED', 'Operação Git cancelada.'));
      return;
    }
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: options.timeoutMs ?? 60_000,
        maxBuffer: MAX_GIT_OUTPUT,
        windowsHide: true,
        ...(options.signal ? { signal: options.signal } : {}),
        env: gitEnv(options.env),
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new HiveError('GIT', GIT_MISSING));
          return;
        }
        if (error && (error.name === 'AbortError' || options.signal?.aborted)) {
          reject(new HiveError('CANCELLED', 'Operação Git cancelada.'));
          return;
        }
        // Output over the buffer limit is never a usable result, even when failure is allowed.
        const overflow =
          (error as NodeJS.ErrnoException | null)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        if ((code !== 0 && !options.allowFailure) || overflow) {
          reject(new HiveError('GIT', failureMessage(args, error, stdout, stderr)));
          return;
        }
        resolve({ stdout, stderr, code });
      },
    );
  });
}

/**
 * Reads at most `maxBytes` of a git command's output, then stops the process. For output that
 * can be arbitrarily large (a patch) and is only shown in part anyway.
 */
export function gitCapped(
  cwd: string,
  args: string[],
  maxBytes: number,
  options: { timeoutMs?: number } = {},
): Promise<{ stdout: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true, env: gitEnv() });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() =>
        reject(new HiveError('TIMEOUT', `git ${args[0]} passou do tempo limite e foi encerrado.`)),
      );
    }, options.timeoutMs ?? 60_000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return;
      const room = maxBytes - size;
      if (chunk.length >= room) {
        chunks.push(chunk.subarray(0, Math.max(0, room)));
        size = maxBytes;
        truncated = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 16_000) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) =>
      finish(() =>
        reject(
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? new HiveError('GIT', GIT_MISSING)
            : new HiveError('GIT', failureMessage(args, error, '', stderr)),
        ),
      ),
    );
    child.on('close', (code) =>
      finish(() => {
        if (!truncated && code !== 0) {
          reject(new HiveError('GIT', failureMessage(args, null, '', stderr || `exit ${code}`)));
          return;
        }
        resolve({ stdout: Buffer.concat(chunks).toString('utf8'), truncated });
      }),
    );
  });
}

/** Identity and safety flags for commits Hive makes on its own task branches. */
export const hiveCommitFlags = [
  '-c',
  'user.name=Hive',
  '-c',
  'user.email=hive@localhost',
  '-c',
  'commit.gpgsign=false',
];
