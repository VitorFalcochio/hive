import { spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { killTree } from '@hive/agents';
import type { TerminalEvent, TerminalSession, TerminalStatus } from '@hive/core';
import { HiveError, newId, nowIso, resolveInside } from '@hive/shared';

const MAX_CAPTURE = 1024 * 1024;
const MAX_SESSIONS = 20;
const URL_SCAN_TAIL = 512;

interface ManagedSession {
  session: TerminalSession;
  child: ChildProcess;
  stopRequested: boolean;
  finished: boolean;
  scanTail: string;
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
  private disposed = false;

  constructor(private readonly emit: (event: TerminalEvent) => void) {}

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
  ): Promise<TerminalSession> {
    if (this.disposed) throw new HiveError('INTERNAL', 'O terminal já foi encerrado.');
    const cwd = await resolveInside(workspaceRoot, requestedCwd || '.');
    if (!(await stat(cwd)).isDirectory())
      throw new HiveError('VALIDATION', 'A pasta de execução não é um diretório.');

    this.prune();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      TERM: 'dumb',
      GIT_TERMINAL_PROMPT: '0',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;

    const session: TerminalSession = {
      id: newId('terminal'),
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
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const managed: ManagedSession = {
      session,
      child,
      stopRequested: false,
      finished: false,
      scanTail: '',
    };
    this.sessions.set(session.id, managed);
    this.send({ type: 'started', session: copySession(session) });

    const append = (value: Buffer | string) => {
      const chunk = cleanTerminalOutput(value.toString());
      if (!chunk) return;
      session.output = (session.output + chunk).slice(-MAX_CAPTURE);
      const previewUrls = detectPreviewUrls(managed.scanTail + chunk);
      managed.scanTail = (managed.scanTail + chunk).slice(-URL_SCAN_TAIL);
      for (const url of previewUrls)
        if (!session.previewUrls.includes(url)) session.previewUrls.push(url);
      this.send({
        type: 'output',
        sessionId: session.id,
        chunk,
        previewUrls: [...session.previewUrls],
      });
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once('error', (error) => {
      append(`\nNão foi possível iniciar o comando: ${error.message}\n`);
      this.finish(managed, 'failed', null);
    });
    child.once('close', (code) => {
      const status: TerminalStatus = managed.stopRequested
        ? 'stopped'
        : code === 0
          ? 'exited'
          : 'failed';
      this.finish(managed, status, code);
    });
    return copySession(session);
  }

  stop(id: string): TerminalSession {
    const managed = this.require(id);
    if (managed.session.status !== 'running' && managed.session.status !== 'stopping')
      return copySession(managed.session);
    managed.stopRequested = true;
    managed.session.status = 'stopping';
    this.send({ type: 'state', session: copySession(managed.session) });
    if (managed.child.pid) killTree(managed.child.pid);
    return copySession(managed.session);
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
      if (!managed.finished && managed.child.pid) killTree(managed.child.pid);
    }
  }

  private finish(managed: ManagedSession, status: TerminalStatus, exitCode: number | null) {
    if (managed.finished) return;
    managed.finished = true;
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
