import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileService } from './files';

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hive-files-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, windowsHide: true }).toString();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@hive.local');
  await writeFile(path.join(root, 'a.txt'), 'original\n');
  git('add', '.');
  git('-c', 'core.hooksPath=', 'commit', '-m', 'base');
  git('branch', 'other');
  return {
    root,
    git,
    files: new FileService(
      () => root,
      () => undefined,
    ),
  };
}

describe('FileService', { timeout: 30_000 }, () => {
  it('lê e salva arquivos, recusando sobrescrever mudanças feitas por fora', async () => {
    const { root, files } = await setup();
    const read = await files.read('a.txt');
    expect(read.content).toBe('original\n');

    const saved = await files.write('a.txt', 'meu texto\n', read.mtimeMs);
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('meu texto\n');

    // Someone else (an agent applying work, another editor) changes the file.
    await writeFile(path.join(root, 'a.txt'), 'de fora\n');
    const later = new Date(saved.mtimeMs + 5_000);
    await utimes(path.join(root, 'a.txt'), later, later);
    await expect(files.write('a.txt', 'perderia o de fora\n', saved.mtimeMs)).rejects.toThrow(
      'alterado fora do editor',
    );
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('de fora\n');
    await files.write('a.txt', 'forçado\n', null);
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('forçado\n');
  });

  it('não sai da pasta do projeto nem acessa .git', async () => {
    const { files } = await setup();
    await expect(files.read('../fora.txt')).rejects.toThrow();
    await expect(files.write('.git/config', 'x', null)).rejects.toThrow('.git');
    expect((await files.list('')).map((entry) => entry.name)).toEqual(['a.txt']);
  });

  it('mostra o diff da cópia de trabalho e lista arquivos alterados', async () => {
    const { files } = await setup();
    await files.write('a.txt', 'alterado\n', null);
    await files.create('novo/b.txt', 'file');
    const diff = await files.workingDiff('a.txt');
    expect(diff).toEqual({ path: 'a.txt', original: 'original\n', modified: 'alterado\n' });
    const status = await files.gitStatus();
    expect(status.branch).toBe('main');
    expect(status.files.map((file) => file.path).sort()).toEqual(['a.txt', 'novo/b.txt']);
    expect(await files.files()).toEqual(expect.arrayContaining(['a.txt', 'novo/b.txt']));
  });

  it('só troca de branch sem alterações pendentes', async () => {
    const { files } = await setup();
    await files.write('a.txt', 'sujo\n', null);
    await expect(files.checkout('other')).rejects.toThrow('não commitadas');
    await files.write('a.txt', 'original\n', null);
    await files.checkout('other');
    expect((await files.branches()).current).toBe('other');
    await expect(files.checkout('nao-existe')).rejects.toThrow('não encontrada');
  });

  it('não abre binários no editor', async () => {
    const { root, files } = await setup();
    await writeFile(path.join(root, 'img.bin'), Buffer.from([0, 1, 2, 0]));
    const read = await files.read('img.bin');
    expect(read).toMatchObject({ binary: true, content: null });
  });
});
