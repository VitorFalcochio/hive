import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { errorMessage } from '@hive/shared';

/**
 * Opens a Hive command in a terminal. `write` reaches the shell through the command's own
 * output, `end` gives the terminal back, and the returned function is told the shell is gone.
 */
export type CommandLauncher = (request: {
  terminalId: string;
  /** 'agents', or 'hive' with an optional subcommand in `argument`. */
  command: string;
  argument: string;
  write: (text: string) => void;
  end: () => void;
}) => () => void;

export interface ControlServer {
  url: string;
  token: string;
  close: () => Promise<void>;
}

const COMMANDS = new Set(['agents', 'hive']);

/**
 * The local endpoint behind the `agents` and `hive` commands of Hive's terminals. It listens on
 * 127.0.0.1 only and answers only requests carrying the token given to those terminals.
 */
export async function startControlServer(launch: CommandLauncher): Promise<ControlServer> {
  const token = randomBytes(24).toString('hex');
  const expected = Buffer.from(token);
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const given = Buffer.from(String(request.headers['x-hive-token'] ?? ''));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      response.writeHead(403).end();
      return;
    }
    const terminalId = url.searchParams.get('terminal') ?? '';
    const command = url.searchParams.get('command') ?? '';
    const argument = (url.searchParams.get('argument') ?? '').trim().toLowerCase();
    if (request.method !== 'POST' || url.pathname !== '/attach' || !COMMANDS.has(command)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      response.end();
    };
    try {
      const detach = launch({
        terminalId,
        command,
        argument,
        write: (text) => {
          if (!ended) response.write(text);
        },
        end,
      });
      // The shell went away (terminal closed, curl killed): the command stops too.
      response.on('close', () => {
        ended = true;
        detach();
      });
    } catch (error) {
      response.write(`\x1b[38;2;248;113;133m${errorMessage(error)}\x1b[0m\r\n`);
      end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Endereço inválido.');
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Writes the `agents` and `hive` commands into `binDir`: tiny scripts that ask Hive to open the
 * command in their terminal through curl, which streams what Hive draws. The terminal's own
 * variables (HIVE_CONTROL, HIVE_TOKEN, HIVE_TERMINAL) say where and to whom.
 */
export async function writeCommandShims(binDir: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  const request = (command: string, quote: (name: string) => string, argument: string) =>
    `curl -sN -X POST -H "x-hive-token: ${quote('HIVE_TOKEN')}" "${quote('HIVE_CONTROL')}/attach?terminal=${quote('HIVE_TERMINAL')}&command=${command}&argument=${argument}"`;
  for (const [name, command] of [
    ['agents', 'agents'],
    ['hive', 'hive'],
  ] as const) {
    // cmd needs the UTF-8 code page for Hive's text, and gets the user's back afterwards.
    const windows = [
      '@echo off',
      'setlocal',
      'if not defined HIVE_CONTROL (echo Este comando funciona nos terminais do Hive. & exit /b 1)',
      'for /f "tokens=2 delims=:." %%a in (\'chcp\') do set HIVE_CODEPAGE=%%a',
      'chcp 65001 >nul',
      request(command, (variable) => `%${variable}%`, '%~1').replace('curl ', 'curl.exe '),
      'chcp %HIVE_CODEPAGE% >nul',
      '',
    ].join('\r\n');
    const posix = [
      '#!/bin/sh',
      '[ -n "$HIVE_CONTROL" ] || { echo "Este comando funciona nos terminais do Hive."; exit 1; }',
      `exec ${request(command, (variable) => `$${variable}`, '$1')}`,
      '',
    ].join('\n');
    await writeFile(path.join(binDir, `${name}.cmd`), windows);
    await writeFile(path.join(binDir, name), posix);
    await chmod(path.join(binDir, name), 0o755).catch(() => undefined);
  }
}
