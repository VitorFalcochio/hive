import { mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { git } from './git';
import {
  diffRefs,
  inspectRepository,
  listWorktrees,
  statusPorcelain,
  taskBranchName,
  WorktreeManager,
} from './repository';

const identity = ['-c', 'user.name=Teste', '-c', 'user.email=teste@hive.local'];

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hive-repo-'));
  await git(root, ['init', '-q', '-b', 'main']);
  await writeFile(path.join(root, 'app.txt'), 'um\n');
  await git(root, ['add', '-A']);
  await git(root, [...identity, 'commit', '-q', '-m', 'inicio']);
  const worktrees = await mkdtemp(path.join(os.tmpdir(), 'hive-worktrees-'));
  return { root, manager: new WorktreeManager(root, worktrees), worktrees };
}

describe('repositório e worktrees', { timeout: 30_000 }, () => {
  it('identifica o repositório, a branch e o commit atual', async () => {
    const { root } = await repository();
    const info = await inspectRepository(path.join(root));
    expect(info.branch).toBe('main');
    expect(info.head).toMatch(/^[0-9a-f]{40}$/);
    const plain = await mkdtemp(path.join(os.tmpdir(), 'hive-plain-'));
    // The temporary folder may itself sit inside a repository (Hive's own, during npm test).
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(plain);
    try {
      await expect(inspectRepository(plain)).rejects.toMatchObject({ code: 'NOT_A_GIT_REPO' });
    } finally {
      delete process.env.GIT_CEILING_DIRECTORIES;
    }
  });

  it('lista alterações, inclusive renomeações, sem inventar entradas', async () => {
    const { root } = await repository();
    await rename(path.join(root, 'app.txt'), path.join(root, 'novo.txt'));
    await git(root, ['add', '-A']);
    await writeFile(path.join(root, 'solto.txt'), 'x\n');
    expect(await statusPorcelain(root)).toEqual([
      { status: 'R', path: 'novo.txt' },
      { status: '??', path: 'solto.txt' },
    ]);
  });

  it('dá a cada tarefa uma branch hive/ com nome seguro', () => {
    expect(taskBranchName('run_abcdef123456', 'Tela de Login!', 2)).toBe(
      'hive/abcdef12/tela-de-login-a2',
    );
    expect(taskBranchName('run_x', '***', 1)).toBe('hive/x/task-a1');
  });

  it('cria a worktree, guarda o trabalho num commit, mostra o diff e remove tudo', async () => {
    const { root, manager, worktrees } = await repository();
    const head = (await manager.headOf('main'))!;
    const worktree = await manager.create('t1', 'hive/t/t1-a1', head);
    expect(worktree.startsWith(worktrees)).toBe(true);
    expect(await manager.commitAll(worktree, 'nada')).toBeNull();

    await writeFile(path.join(worktree, 'app.txt'), 'um\ndois\n');
    await writeFile(path.join(worktree, 'novo.txt'), 'novo\n');
    const commit = await manager.commitAll(worktree, 'hive: tarefa');
    expect(commit).toMatch(/^[0-9a-f]{40}$/);

    const diff = await diffRefs(root, head, commit);
    expect(diff.files).toEqual([
      { path: 'app.txt', status: 'M', insertions: 1, deletions: 0 },
      { path: 'novo.txt', status: 'A', insertions: 1, deletions: 0 },
    ]);
    expect(diff.patch).toContain('+dois');
    // The user's own checkout is untouched until they apply the result.
    expect((await readFile(path.join(root, 'app.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe(
      'um\n',
    );

    await manager.remove(worktree, 'hive/t/t1-a1');
    expect((await listWorktrees(root)).map((entry) => entry.branch)).toEqual(['main']);
    expect(await manager.headOf('hive/t/t1-a1')).toBeNull();
  });

  it('não toca em nada fora da pasta do Hive nem em branches do usuário', async () => {
    const { root, manager } = await repository();
    await expect(manager.create('t', 'feature/minha', 'main')).rejects.toThrow('hive/');
    await expect(manager.create('../fora', 'hive/x/y-a1', 'main')).rejects.toMatchObject({
      code: 'FORBIDDEN_PATH',
    });
    await expect(manager.remove(root, null)).rejects.toMatchObject({ code: 'FORBIDDEN_PATH' });
    await expect(manager.commitAll(root, 'x')).rejects.toMatchObject({ code: 'FORBIDDEN_PATH' });
    await manager.remove(path.join(manager.worktreeRoot, 'sumida'), 'main');
    expect(await manager.headOf('main')).not.toBeNull();
  });

  it('traz a branch de uma dependência e desfaz o merge quando há conflito', async () => {
    const { manager } = await repository();
    const base = (await manager.headOf('main'))!;
    const first = await manager.create('a', 'hive/t/a-a1', base);
    await writeFile(path.join(first, 'app.txt'), 'versão a\n');
    await manager.commitAll(first, 'a');
    const second = await manager.create('b', 'hive/t/b-a1', base);
    await writeFile(path.join(second, 'app.txt'), 'versão b\n');
    await manager.commitAll(second, 'b');

    await expect(manager.mergeBranch(second, 'hive/t/a-a1')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await statusPorcelain(second)).toEqual([]);
    // Git may check files out with CRLF (core.autocrlf); only the content matters here.
    const content = await readFile(path.join(second, 'app.txt'), 'utf8');
    expect(content.replace(/\r\n/g, '\n')).toBe('versão b\n');
  });
});
