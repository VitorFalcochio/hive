import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CommandEvidence, Worker } from '@hive/core';
import { executeTool, type ToolContext } from './tools';
import type { RuntimeEvent } from './runtime';

async function sandbox(options: { allow?: string[]; approve?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hive-tools-'));
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, '.git', 'config'), '[core]\n');
  await writeFile(path.join(root, 'app.ts'), 'const a = 1;\r\nconst b = 2;\r\n');
  const approvals: string[] = [];
  const events: RuntimeEvent[] = [];
  const ctx: ToolContext = {
    root,
    worker: { autoApproveCommands: options.allow ?? [] } as unknown as Worker,
    skills: [],
    signal: new AbortController().signal,
    commandTimeoutMs: 10_000,
    requestApproval: async ({ command }) => {
      approvals.push(command);
      return options.approve ?? false;
    },
    emit: (event) => events.push(event),
    commands: [] as CommandEvidence[],
    vision: true,
  };
  return { root, ctx, approvals, events };
}

describe('caixa de areia das ferramentas dos agentes', () => {
  it('não lê nem escreve fora do projeto', async () => {
    const { ctx } = await sandbox();
    for (const target of ['../fora.txt', path.join(os.tmpdir(), 'fora.txt'), 'a\0b']) {
      const read = await executeTool(ctx, 'read_file', { path: target });
      const write = await executeTool(ctx, 'write_file', { path: target, content: 'x' });
      expect(read.isError).toBe(true);
      expect(write.isError).toBe(true);
    }
  });

  it('não escreve no .git, nem por outro nome nem por um atalho', async () => {
    const { root, ctx } = await sandbox();
    // A junction needs no special rights on Windows; elsewhere it is an ordinary symlink.
    await symlink(path.join(root, '.git'), path.join(root, 'atalho'), 'junction');
    for (const target of ['.git/config', '.GIT/config', 'src/../.git/config', 'atalho/config']) {
      const write = await executeTool(ctx, 'write_file', { path: target, content: 'hack' });
      expect(write.isError, target).toBe(true);
      const edit = await executeTool(ctx, 'replace_in_file', {
        path: target,
        old_string: '[core]',
        new_string: 'hack',
      });
      expect(edit.isError, target).toBe(true);
    }
    expect(await readFile(path.join(root, '.git', 'config'), 'utf8')).toBe('[core]\n');
  });

  it('edita trechos exatos, respeitando quebras de linha do Windows', async () => {
    const { root, ctx, events } = await sandbox();
    const edit = await executeTool(ctx, 'replace_in_file', {
      path: 'app.ts',
      old_string: 'const a = 1;\nconst b = 2;',
      new_string: 'const a = 10;\nconst b = 20;',
    });
    expect(edit.isError).toBe(false);
    expect(await readFile(path.join(root, 'app.ts'), 'utf8')).toBe(
      'const a = 10;\r\nconst b = 20;\r\n',
    );
    expect(events.some((event) => event.type === 'file.changed')).toBe(true);
    const missing = await executeTool(ctx, 'replace_in_file', {
      path: 'app.ts',
      old_string: 'não existe',
      new_string: 'x',
    });
    expect(missing).toMatchObject({ isError: true });
  });

  it('pede aprovação para comandos fora da lista e respeita a recusa', async () => {
    const { ctx, approvals } = await sandbox({ allow: ['node --version'] });
    const denied = await executeTool(ctx, 'run_command', { command: 'node -e "1"' });
    expect(denied.isError).toBe(true);
    expect(denied.output).toContain('denied');
    expect(approvals).toEqual(['node -e "1"']);

    const allowed = await executeTool(ctx, 'run_command', { command: 'node --version' });
    expect(allowed.output).toContain('exit code 0');
    expect(approvals).toHaveLength(1);
  });

  it('não deixa uma quebra de linha esconder um segundo comando na lista de permitidos', async () => {
    const { ctx, approvals } = await sandbox({ allow: ['node --version *'] });
    const sneaky = "node --version\nnode -e \"require('fs').writeFileSync('pwned', 'x')\"";
    await executeTool(ctx, 'run_command', { command: sneaky });
    expect(approvals).toEqual([sneaky]);
  });

  it('lê arquivos em trechos e diz como continuar', async () => {
    const { root, ctx } = await sandbox();
    await writeFile(
      path.join(root, 'longo.txt'),
      Array.from({ length: 1000 }, (_, i) => `linha ${i + 1}`).join('\n'),
    );
    const first = await executeTool(ctx, 'read_file', { path: 'longo.txt' });
    expect(first.output).toContain('lines 1-400 of 1000; pass start_line=401');
    expect(first.output).not.toContain('linha 401');
    const next = await executeTool(ctx, 'read_file', { path: 'longo.txt', start_line: 401 });
    expect(next.output).toContain('linha 401');
  });
});
