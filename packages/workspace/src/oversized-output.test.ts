import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { git, gitCapped } from './git';
import { diffRefs, WorktreeManager } from './repository';

/**
 * The failure behind the frozen Hive of 2026-11-19: an agent's npm install in a project with
 * no .gitignore put thousands of node_modules files in the task snapshot, `git diff` passed
 * 64 MB, and the whole output became an error message stored and shown by the app.
 */
const identity = ['-c', 'user.name=Teste', '-c', 'user.email=teste@hive.local'];

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hive-big-'));
  await git(root, ['init', '-q', '-b', 'main']);
  await writeFile(path.join(root, 'app.txt'), 'um\n');
  await git(root, ['add', '-A']);
  await git(root, [...identity, 'commit', '-q', '-m', 'inicio']);
  const worktrees = await mkdtemp(path.join(os.tmpdir(), 'hive-big-wt-'));
  return { root, manager: new WorktreeManager(root, worktrees) };
}

describe('saídas grandes do git', { timeout: 60_000 }, () => {
  it('o retrato da tarefa nunca leva node_modules, mesmo sem .gitignore', async () => {
    const { root, manager } = await repository();
    const head = (await manager.headOf('main'))!;
    const worktree = await manager.create('t1', 'hive/t/t1-a1', head);
    await mkdir(path.join(worktree, 'node_modules', 'pacote'), { recursive: true });
    await writeFile(path.join(worktree, 'node_modules', 'pacote', 'index.js'), 'x\n');
    await mkdir(path.join(worktree, 'web', 'node_modules', 'outro'), { recursive: true });
    await writeFile(path.join(worktree, 'web', 'node_modules', 'outro', 'a.js'), 'y\n');
    await writeFile(path.join(worktree, 'app.txt'), 'um\ndois\n');
    const commit = await manager.commitAll(worktree, 'hive: tarefa');
    const files = (await git(root, ['show', '--name-only', '--format=', commit!])).stdout
      .trim()
      .split('\n');
    expect(files).toEqual(['app.txt']);
  });

  it('só node_modules mudou: não há o que guardar', async () => {
    const { manager } = await repository();
    const head = (await manager.headOf('main'))!;
    const worktree = await manager.create('t2', 'hive/t/t2-a1', head);
    await mkdir(path.join(worktree, 'node_modules'), { recursive: true });
    await writeFile(path.join(worktree, 'node_modules', 'x.js'), 'x\n');
    expect(await manager.commitAll(worktree, 'nada')).toBeNull();
  });

  it('o diff lê só a parte mostrada do patch, por maior que ele seja', async () => {
    const { root } = await repository();
    const head = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
    // ~3 MB of patch, against a 50 KB limit.
    const line = 'x'.repeat(99) + '\n';
    await writeFile(path.join(root, 'grande.txt'), line.repeat(30_000));
    await git(root, ['add', '-A']);
    await git(root, [...identity, 'commit', '-q', '-m', 'grande']);
    const diff = await diffRefs(root, head, 'HEAD', 50_000);
    expect(diff.truncated).toBe(true);
    expect(diff.patch.length).toBeLessThanOrEqual(50_000);
    expect(diff.files).toEqual([
      { path: 'grande.txt', status: 'A', insertions: 30_000, deletions: 0 },
    ]);
  });

  it('gitCapped devolve a saída inteira quando cabe', async () => {
    const { root } = await repository();
    const result = await gitCapped(root, ['log', '--format=%s'], 10_000);
    expect(result).toEqual({ stdout: 'inicio\n', truncated: false });
  });

  it('erro do git é limitado, nunca a saída inteira', async () => {
    const { root } = await repository();
    // A failing command whose only text is a long stdout: before, all of it became the error.
    await writeFile(path.join(root, 'app.txt'), ('linha longa '.repeat(20) + '\n').repeat(5_000));
    // autocrlf off: a line-ending warning on stderr would be the message instead of stdout.
    const failure = (await git(root, ['-c', 'core.autocrlf=false', 'diff', '--exit-code']).catch(
      (e: unknown) => e,
    )) as Error;
    expect(failure.message).toMatch(/^git -c failed: diff --git/);
    expect(failure.message.length).toBeLessThan(5_000);
    expect(failure.message).toContain('caracteres omitidos');
    await expect(gitCapped(root, ['nao-existe'], 1_000)).rejects.toMatchObject({ code: 'GIT' });
  });
});
