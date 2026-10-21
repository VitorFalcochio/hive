import { afterEach, describe, expect, it } from 'vitest';
import type { TerminalEvent } from '@hive/core';
import { cleanTerminalOutput, detectPreviewUrls, TerminalManager } from './terminal';

const managers: TerminalManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
});

async function waitUntil(check: () => boolean, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Tempo esgotado aguardando o processo de teste.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function setup() {
  const events: TerminalEvent[] = [];
  const manager = new TerminalManager((event) => events.push(event));
  managers.push(manager);
  return { manager, events };
}

describe('TerminalManager', { timeout: 15_000 }, () => {
  it('limpa sequências de terminal e encontra endereços locais', () => {
    expect(cleanTerminalOutput('\u001b[32mpronto\u001b[0m\r50%\r100%')).toBe('pronto\n50%\n100%');
    expect(
      detectPreviewUrls(
        'Local: http://localhost:5173/\nNetwork: http://0.0.0.0:4173/app), externo https://example.com',
      ),
    ).toEqual(['http://localhost:5173/', 'http://127.0.0.1:4173/app']);
  });

  it('transmite a saída, detecta o preview e guarda a sessão concluída', async () => {
    const { manager, events } = setup();
    const node = JSON.stringify(process.execPath);
    const session = await manager.start(
      'ws-test',
      process.cwd(),
      `${node} -e "console.log('ready http://localhost:4321/app')"`,
    );

    await waitUntil(() => manager.list('ws-test')[0]?.status === 'exited');
    const finished = manager.list('ws-test')[0]!;
    expect(finished.output).toContain('ready http://localhost:4321/app');
    expect(finished.previewUrls).toEqual(['http://localhost:4321/app']);
    expect(finished.exitCode).toBe(0);
    expect(events.some((event) => event.type === 'output')).toBe(true);

    const cleared = manager.clear(session.id);
    expect(cleared.output).toBe('');
  });

  it('interrompe um processo de longa duração', async () => {
    const { manager } = setup();
    const node = JSON.stringify(process.execPath);
    const session = await manager.start(
      'ws-test',
      process.cwd(),
      `${node} -e "setInterval(() => {}, 1000)"`,
    );
    expect(manager.stop(session.id).status).toBe('stopping');
    await waitUntil(() => manager.list('ws-test')[0]?.status === 'stopped');
    expect(manager.list('ws-test')[0]?.endedAt).not.toBeNull();
  });
});
