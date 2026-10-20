import { spawn, execFile } from 'node:child_process';

export interface CommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

const MAX_CAPTURE = 256 * 1024;

/** Kill a process and all its children. On Windows `taskkill /T` is the only reliable way. */
export function killTree(pid: number): void {
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}

/**
 * Run a shell command in `cwd` with a timeout and cancellation. The environment is minimal:
 * provider credentials never live in process.env, and Electron-specific variables are removed.
 */
export function runCommand(
  command: string,
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal; onOutput?: (chunk: string) => void },
): Promise<CommandResult> {
  const started = Date.now();
  if (options.signal?.aborted) {
    return Promise.resolve({ exitCode: null, output: '', timedOut: false, cancelled: true, durationMs: 0 });
  }
  return new Promise((resolve) => {
    const env = { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    let cancelled = false;
    const append = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      output = (output + text).slice(-MAX_CAPTURE);
      options.onOutput?.(text);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, options.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      if (child.pid) killTree(child.pid);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode, output, timedOut, cancelled, durationMs: Date.now() - started });
    };
    child.on('error', (error) => {
      output += `\n${error.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}
