import { execFile } from 'node:child_process';
import { HiveError, errorMessage } from '@hive/shared';

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
  options: { timeoutMs?: number; allowFailure?: boolean } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: options.timeoutMs ?? 60_000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_EDITOR: 'true',
          GIT_PAGER: 'cat',
          GCM_INTERACTIVE: 'never',
          LC_ALL: 'C',
        },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new HiveError('GIT', 'Git is not installed or not on PATH.'));
          return;
        }
        if (code !== 0 && !options.allowFailure) {
          reject(
            new HiveError(
              'GIT',
              `git ${args[0]} failed: ${(stderr || stdout || errorMessage(error)).trim()}`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr, code });
      },
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
