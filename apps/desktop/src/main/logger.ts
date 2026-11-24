import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { clipText, errorMessage, secretRedactor } from '@hive/shared';

/**
 * A log file in the data folder. The installed app has no console, so before this every
 * `console.error` vanished: a freeze or a failed mission left nothing to look at afterwards.
 * Writes are synchronous on purpose (a crash must not lose its last line) and rare: errors,
 * warnings and lifecycle events only, each line bounded.
 */
const MAX_FILE = 5 * 1024 * 1024;
const MAX_LINE = 16_000;
let file: string | null = null;

export type LogLevel = 'info' | 'warn' | 'error';

/** One line as the Guardian sees it, already bounded and with secrets removed. */
export interface LogEntry {
  at: string;
  level: LogLevel;
  scope: string;
  text: string;
}

type LogListener = (entry: LogEntry) => void;
const listeners = new Set<LogListener>();

/**
 * Hears every line written from now on (Hive Guardian follows frozen windows and crashes this
 * way instead of detecting them a second time). Returns how to stop listening.
 */
export function onLog(listener: LogListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function logFile(): string | null {
  return file;
}

function describe(value: unknown): string {
  if (value instanceof Error) {
    const cause = value.cause === undefined ? '' : `\nCausa: ${describe(value.cause)}`;
    return `${value.stack ?? `${value.name}: ${value.message}`}${cause}`;
  }
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return errorMessage(value);
  }
}

export function log(level: LogLevel, scope: string, ...parts: unknown[]): void {
  if (!file) return;
  const text = secretRedactor.redact(clipText(parts.map(describe).join(' '), MAX_LINE));
  const at = new Date().toISOString();
  const line = `${at} ${level.toUpperCase().padEnd(5)} [${scope}] ${text}\n`;
  for (const listener of listeners)
    try {
      listener({ at, level, scope, text });
    } catch {
      // A listener never breaks logging.
    }
  try {
    // One older file is kept, so the log never grows without bound.
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_FILE) {
      rmSync(`${file}.1`, { force: true });
      renameSync(file, `${file}.1`);
    }
    appendFileSync(file, line);
  } catch (error) {
    // The log is not worth stopping the app over; the console still gets the line.
    process.stderr.write(`Log indisponível (${errorMessage(error)}): ${line}`);
  }
}

/**
 * Starts the log in `<dataDir>/logs/main.log` and sends console warnings and errors, uncaught
 * exceptions and unhandled rejections to it, with their stacks.
 */
export function startLog(dataDir: string): string {
  const dir = path.join(dataDir, 'logs');
  mkdirSync(dir, { recursive: true });
  file = path.join(dir, 'main.log');
  const original = { warn: console.warn.bind(console), error: console.error.bind(console) };
  console.warn = (...args: unknown[]) => {
    original.warn(...args);
    log('warn', 'console', ...args);
  };
  console.error = (...args: unknown[]) => {
    original.error(...args);
    log('error', 'console', ...args);
  };
  // Logged, not swallowed: Electron would otherwise show a raw dialog and leave the app in an
  // unknown state; here the failure is recorded with its stack and the app keeps serving.
  process.on('uncaughtException', (error) => log('error', 'uncaught', error));
  process.on('unhandledRejection', (reason) => log('error', 'unhandled-rejection', reason));
  log('info', 'app', `Hive iniciando (pid ${process.pid}).`);
  return file;
}
