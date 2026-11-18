import { spawn, execFile } from 'node:child_process';

export interface CommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

const MAX_CAPTURE = 256 * 1024;
/**
 * How long to wait for stdio to close after the shell itself exited. A child the command left
 * running (`start /b …`, `cmd &`) inherits the pipes and would otherwise keep `close` from ever
 * firing, hanging the agent.
 */
const EXIT_GRACE_MS = 1000;

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

function commandEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: '1',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  return env;
}

/**
 * Run a shell command in `cwd` with a timeout and cancellation. The environment is minimal:
 * provider credentials never live in process.env, and Electron-specific variables are removed.
 */
export function runCommand(
  command: string,
  options: {
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
    onOutput?: (chunk: string) => void;
  },
): Promise<CommandResult> {
  const started = Date.now();
  if (options.signal?.aborted) {
    return Promise.resolve({
      exitCode: null,
      output: '',
      timedOut: false,
      cancelled: true,
      durationMs: 0,
    });
  }
  return new Promise((resolve) => {
    const env = commandEnv();
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
    let done = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode, output, timedOut, cancelled, durationMs: Date.now() - started });
    };
    child.on('error', (error) => {
      output += `\n${error.message}`;
      finish(null);
    });
    child.on('exit', (code) => {
      graceTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code);
      }, EXIT_GRACE_MS);
    });
    child.on('close', (code) => finish(code));
  });
}

export interface BackgroundStart {
  pid: number | null;
  /** True when the process already ended during the startup window (usually an error). */
  exited: boolean;
  exitCode: number | null;
  output: string;
}

interface BackgroundProcess {
  pid: number | null;
  output: string;
  running: boolean;
}

/**
 * Long-running commands (dev servers, watchers) a session started. They keep running across
 * tool calls and are all killed when the session ends.
 */
export class BackgroundProcesses {
  private readonly items: BackgroundProcess[] = [];

  /** Start `command` and return what it printed in its first `waitMs`, or earlier if it exits. */
  start(command: string, options: { cwd: string; waitMs: number }): Promise<BackgroundStart> {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: commandEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const item: BackgroundProcess = { pid: child.pid ?? null, output: '', running: true };
    this.items.push(item);
    const append = (chunk: Buffer) => {
      item.output = (item.output + chunk.toString('utf8')).slice(-MAX_CAPTURE);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    return new Promise((resolve) => {
      let settled = false;
      let exitCode: number | null = null;
      const report = (exited: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ pid: item.pid, exited, exitCode, output: item.output });
      };
      const timer = setTimeout(() => report(false), options.waitMs);
      child.on('error', (error) => {
        item.output += `\n${error.message}`;
        item.running = false;
        report(true);
      });
      child.on('exit', (code) => {
        exitCode = code;
        item.running = false;
        report(true);
      });
    });
  }

  /** Kill every process still running. */
  stopAll(): void {
    for (const item of this.items) {
      if (item.running && item.pid) killTree(item.pid);
      item.running = false;
    }
  }
}
