import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startControlServer, writeCommandShims, type ControlServer } from './control-server';

const servers: ControlServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

describe('comandos do Hive no terminal', () => {
  it('só atende quem tem o token e transmite o que o comando desenha', async () => {
    const launched: string[] = [];
    const server = await startControlServer(({ terminalId, command, argument, write, end }) => {
      launched.push(`${terminalId}:${command}:${argument}`);
      write('olá ');
      setTimeout(() => {
        write('abelha');
        end();
      }, 20);
      return () => undefined;
    });
    servers.push(server);
    const attach = (token: string, command = 'agents') =>
      fetch(`${server.url}/attach?terminal=t1&command=${command}&argument=Agents`, {
        method: 'POST',
        headers: { 'x-hive-token': token },
      });

    expect((await attach('errado')).status).toBe(403);
    expect((await attach(server.token, 'rm')).status).toBe(404);
    const response = await attach(server.token, 'hive');
    expect(await response.text()).toBe('olá abelha');
    expect(launched).toEqual(['t1:hive:agents']);
  });

  it('escreve os atalhos para cmd e para shells POSIX', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hive-bin-'));
    await writeCommandShims(dir);
    const windows = await readFile(path.join(dir, 'agents.cmd'), 'utf8');
    expect(windows).toContain('chcp 65001');
    expect(windows).toContain(
      'curl.exe -sN -X POST -H "x-hive-token: %HIVE_TOKEN%" "%HIVE_CONTROL%/attach?terminal=%HIVE_TERMINAL%&command=agents',
    );
    expect(await readFile(path.join(dir, 'hive'), 'utf8')).toContain('command=hive&argument=$1');
  });
});
