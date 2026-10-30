import { stat } from 'node:fs/promises';
import path from 'node:path';
import * as pty from 'node-pty';
import { killTree } from '@hive/agents';
import type { TerminalEvent, TerminalSession, TerminalStatus } from '@hive/core';
import { HiveError, newId, nowIso, resolveInside } from '@hive/shared';

/** Raw output kept per session (escape sequences included), replayed when a view reopens. */
const MAX_CAPTURE = 1024 * 1024;
const MAX_SESSIONS = 20;
const URL_SCAN_TAIL = 512;
const DEFAULT_SIZE = { cols: 100, rows: 30 };

interface ManagedSession {
  session: TerminalSession;
  terminal: pty.IPty;
  stopRequested: boolean;
  finished: boolean;
  scanTail: string;
  size: { cols: number; rows: number };
}

/** What every terminal gets so the Hive commands (`agents`, `hive`) work in its shell. */
export interface TerminalCommands {
  /** Folder with the command shims, put first on PATH. */
  binDir: string;
  env: Record<string, string>;
}

/**
 * What runs in the pseudo terminal: the user's command through the platform shell, or the
 * shell itself when no command is given (an interactive terminal).
 */
export function shellFor(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[] | string } {
  if (platform === 'win32') {
    if (!command) return { file: 'powershell.exe', args: ['-NoLogo'] };
    // With /s, cmd drops the outer quotes and runs the rest exactly as typed.
    return { file: env.ComSpec || 'cmd.exe', args: `/d /s /c "${command}"` };
  }
  const shell = env.SHELL || '/bin/sh';
  return command ? { file: shell, args: ['-lc', command] } : { file: shell, args: ['-l'] };
}

const escape = String.fromCharCode(27);
const bell = String.fromCharCode(7);
// CSI, OSC and the short two-byte escape sequences commonly emitted by command line tools.
const ansiPattern = new RegExp(
  `${escape}(?:\\][^${bell}]*(?:${bell}|${escape}\\\\)|\\[[0-?]*[ -/]*[@-~]|[@-_])`,
  'g',
);

export function cleanTerminalOutput(value: string): string {
  const normalized = value.replace(ansiPattern, '').replace(/\r(?!\n)/g, '\n');
  let clean = '';
  for (const character of normalized) {
    const code = character.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127))
      clean += character;
  }
  return clean;
}

export function detectPreviewUrls(value: string): string[] {
  const matches = value.matchAll(
    /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{1,5})?(?:\/[^\s'"<>]*)?/gi,
  );
  const urls: string[] = [];
  for (const match of matches) {
    const candidate = match[0].replace(/[),.;!?]+$/, '');
    try {
      const url = new URL(candidate);
      if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
      const normalized = url.toString();
      if (!urls.includes(normalized)) urls.push(normalized);
    } catch {
      // Ignore partial URLs while a process is still writing its output.
    }
  }
  return urls;
}

function copySession(session: TerminalSession): TerminalSession {
  return { ...session, previewUrls: [...session.previewUrls] };
}

export class TerminalManager {
  private readonly sessions = new Map<string, ManagedSession>();
  /** Terminals running a Hive command: their keystrokes go to it, not to the shell. */
  private readonly attached = new Map<string, (data: string) => void>();
  private commands: TerminalCommands | null = null;
  private disposed = false;

  constructor(private readonly emit: (event: TerminalEvent) => void) {}

  /** Terminals opened from now on get the Hive commands. */
  enableCommands(commands: TerminalCommands): void {
    this.commands = commands;
  }

  list(workspaceId: string): TerminalSession[] {
    return [...this.sessions.values()]
      .filter(({ session }) => session.workspaceId === workspaceId)
      .sort((left, right) => right.session.startedAt.localeCompare(left.session.startedAt))
      .map(({ session }) => copySession(session));
  }

  async start(
    workspaceId: string,
    workspaceRoot: string,
    command: string,
    requestedCwd = '.',
    size: { cols: number; rows: number } = DEFAULT_SIZE,
  ): Promise<TerminalSession> {
    if (this.disposed) throw new HiveError('INTERNAL', 'O terminal já foi encerrado.');
    const cwd = await resolveInside(workspaceRoot, requestedCwd || '.');
    if (!(await stat(cwd)).isDirectory())
      throw new HiveError('VALIDATION', 'A pasta de execução não é um diretório.');

    this.prune();
    // A real terminal: colours on, and tools may ask questions, which the user can answer.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    delete env.NO_COLOR;
    delete env.FORCE_COLOR;

    const id = newId('terminal');
    if (this.commands) {
      Object.assign(env, this.commands.env, { HIVE_TERMINAL: id });
      // Windows spells it Path; whatever the spelling, the shims come first.
      const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
      env[key] = [this.commands.binDir, env[key]].filter(Boolean).join(path.delimiter);
    }

    const session: TerminalSession = {
      id,
      workspaceId,
      command,
      cwd,
      status: 'running',
      output: '',
      startedAt: nowIso(),
      endedAt: null,
      exitCode: null,
      previewUrls: [],
    };
    const { file, args } = shellFor(command);
    let terminal: pty.IPty;
    try {
      terminal = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: size.cols,
        rows: size.rows,
        cwd,
        env: env as Record<string, string>,
      });
    } catch (error) {
      throw new HiveError(
        'VALIDATION',
        `Não foi possível abrir o terminal: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const managed: ManagedSession = {
      session,
      terminal,
      stopRequested: false,
      finished: false,
      scanTail: '',
      size: { ...size },
    };
    this.sessions.set(session.id, managed);
    this.send({ type: 'started', session: copySession(session) });

    // The view gets the raw stream (colours, cursor moves); URLs are read from clean text.
    terminal.onData((chunk) => {
      session.output = (session.output + chunk).slice(-MAX_CAPTURE);
      const clean = cleanTerminalOutput(chunk);
      const previewUrls = detectPreviewUrls(managed.scanTail + clean);
      managed.scanTail = (managed.scanTail + clean).slice(-URL_SCAN_TAIL);
      for (const url of previewUrls)
        if (!session.previewUrls.includes(url)) session.previewUrls.push(url);
      this.send({
        type: 'output',
        sessionId: session.id,
        chunk,
        previewUrls: [...session.previewUrls],
      });
    });
    terminal.onExit(({ exitCode }) => {
      const status: TerminalStatus = managed.stopRequested
        ? 'stopped'
        : exitCode === 0
          ? 'exited'
          : 'failed';
      this.finish(managed, status, exitCode);
    });
    return copySession(session);
  }

  /** Keystrokes and pasted text typed into a running terminal. */
  write(id: string, data: string): void {
    const managed = this.require(id);
    if (managed.finished || managed.session.status !== 'running') return;
    const command = this.attached.get(id);
    if (command) command(data);
    else managed.terminal.write(data);
  }

  /**
   * Sends the terminal's keystrokes to `onInput` until the returned function is called, while
   * a Hive command runs in it. Its output still reaches the terminal through the shell.
   */
  attach(id: string, onInput: (data: string) => void): () => void {
    const managed = this.require(id);
    if (managed.finished) throw new HiveError('VALIDATION', 'O terminal já foi encerrado.');
    if (this.attached.has(id))
      throw new HiveError('CONFLICT', 'Já há um comando do Hive aberto neste terminal.');
    this.attached.set(id, onInput);
    return () => {
      if (this.attached.get(id) === onInput) this.attached.delete(id);
    };
  }

  /** The terminal's size and project, for a Hive command running in it. */
  /** A session with its output so far, finished or not; null once it was pruned or never existed. */
  get(id: string): TerminalSession | null {
    const managed = this.sessions.get(id);
    return managed ? copySession(managed.session) : null;
  }

  describe(id: string): { workspaceId: string; cwd: string; cols: number; rows: number } | null {
    const managed = this.sessions.get(id);
    if (!managed || managed.finished) return null;
    return { workspaceId: managed.session.workspaceId, cwd: managed.session.cwd, ...managed.size };
  }

  resize(id: string, cols: number, rows: number): void {
    const managed = this.require(id);
    if (managed.finished) return;
    managed.size = { cols: Math.max(2, cols), rows: Math.max(2, rows) };
    try {
      managed.terminal.resize(managed.size.cols, managed.size.rows);
    } catch {
      // The process may exit between the check and the resize.
    }
  }

  stop(id: string): TerminalSession {
    const managed = this.require(id);
    if (managed.session.status !== 'running' && managed.session.status !== 'stopping')
      return copySession(managed.session);
    managed.stopRequested = true;
    managed.session.status = 'stopping';
    this.send({ type: 'state', session: copySession(managed.session) });
    this.kill(managed);
    return copySession(managed.session);
  }

  /** Ends the whole process tree (a dev server spawns children), then the terminal itself. */
  private kill(managed: ManagedSession) {
    if (managed.terminal.pid) killTree(managed.terminal.pid);
    try {
      managed.terminal.kill();
    } catch {
      // Already gone.
    }
  }

  clear(id: string): TerminalSession {
    const managed = this.require(id);
    managed.session.output = '';
    managed.scanTail = '';
    this.send({ type: 'state', session: copySession(managed.session) });
    return copySession(managed.session);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const managed of this.sessions.values()) {
      managed.stopRequested = true;
      if (!managed.finished) this.kill(managed);
    }
  }

  private finish(managed: ManagedSession, status: TerminalStatus, exitCode: number | null) {
    if (managed.finished) return;
    managed.finished = true;
    this.attached.delete(managed.session.id);
    managed.session.status = status;
    managed.session.exitCode = exitCode;
    managed.session.endedAt = nowIso();
    this.send({ type: 'state', session: copySession(managed.session) });
  }

  private require(id: string): ManagedSession {
    const session = this.sessions.get(id);
    if (!session) throw new HiveError('NOT_FOUND', 'Terminal não encontrado.');
    return session;
  }

  private prune() {
    const removable = [...this.sessions.values()]
      .filter(({ session }) => !['running', 'stopping'].includes(session.status))
      .sort((left, right) => left.session.startedAt.localeCompare(right.session.startedAt));
    while (this.sessions.size >= MAX_SESSIONS && removable.length) {
      const oldest = removable.shift();
      if (oldest) this.sessions.delete(oldest.session.id);
    }
  }

  private send(event: TerminalEvent) {
    if (!this.disposed) this.emit(event);
  }
}
