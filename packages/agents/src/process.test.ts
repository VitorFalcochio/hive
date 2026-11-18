import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BackgroundProcesses, runCommand } from './process';

const node = `"${process.execPath}"`;

async function script(source: string): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hive-process-'));
  const file = path.join(dir, 'script.cjs');
  await writeFile(file, source);
  return { dir, file };
}

async function waitUntil(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

const answers = (url: string) => () =>
  fetch(url).then(
    () => true,
    () => false,
  );

describe('comandos dos agentes', () => {
  it('termina quando o shell sai, mesmo com um filho segurando a saída (caso real: start /b)', async () => {
    // From a real run: `start "x" /b python -m http.server 8000` hung the agent for minutes.
    const { dir, file } = await script('console.log(process.pid);\nsetTimeout(() => {}, 30000);\n');
    const command =
      process.platform === 'win32'
        ? `start "hive-test" /b ${node} "${file}"`
        : `${node} "${file}" &`;
    const started = Date.now();
    const result = await runCommand(command, { cwd: dir, timeoutMs: 25_000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    await waitUntil(async () => /\d+/.test(result.output), 1000);
    const pid = Number(/\d+/.exec(result.output)?.[0]);
    try {
      if (pid) process.kill(pid);
    } catch {
      // already gone
    }
  }, 30_000);

  it('deixa um servidor rodando em segundo plano e o encerra no fim', async () => {
    const { dir, file } = await script(
      "const server = require('node:http').createServer((_, res) => res.end('ok'));\n" +
        "server.listen(0, '127.0.0.1', () => console.log('port ' + server.address().port));\n",
    );
    const background = new BackgroundProcesses();
    const started = await background.start(`${node} "${file}"`, { cwd: dir, waitMs: 2000 });
    expect(started.exited).toBe(false);
    const port = /port (\d+)/.exec(started.output)?.[1];
    expect(port).toBeDefined();
    const url = `http://127.0.0.1:${port}/`;
    expect(await (await fetch(url)).text()).toBe('ok');

    background.stopAll();
    expect(await waitUntil(async () => !(await answers(url)()), 5000)).toBe(true);
  }, 20_000);

  it('avisa quando o comando em segundo plano já falha ao iniciar', async () => {
    const { dir, file } = await script("console.error('boom'); process.exit(3);\n");
    const started = await new BackgroundProcesses().start(`${node} "${file}"`, {
      cwd: dir,
      waitMs: 5000,
    });
    expect(started).toMatchObject({ exited: true, exitCode: 3 });
    expect(started.output).toContain('boom');
  }, 20_000);
});
