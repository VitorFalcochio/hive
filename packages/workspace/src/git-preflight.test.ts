import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { GIT_MISSING, gitPreflight, isEnvironmentFailure } from './git';

const run = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, windowsHide: true });

it('explica cada motivo que impede uma missão de rodar, e libera um repositório com commit', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'hive-preflight-'));
  expect(await gitPreflight(path.join(folder, 'sumiu'))).toContain('não existe mais');
  expect(await gitPreflight(folder)).toContain('não é um repositório Git');
  run(folder, ['init', '-b', 'main']);
  expect(await gitPreflight(folder)).toContain('ainda não tem nenhum commit');
  await writeFile(path.join(folder, 'README.md'), '# ok\n');
  run(folder, ['add', 'README.md']);
  run(folder, [
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@hive.local',
    '-c',
    'core.hooksPath=',
    'commit',
    '-m',
    'i',
  ]);
  expect(await gitPreflight(folder)).toBeNull();
});

it('reconhece falhas do computador, que nova tentativa nenhuma resolve', () => {
  expect(isEnvironmentFailure(GIT_MISSING)).toBe(true);
  expect(isEnvironmentFailure('git worktree failed: fatal: not a git repository')).toBe(true);
  expect(isEnvironmentFailure('Provider error 413. Request too large')).toBe(false);
  expect(isEnvironmentFailure(null)).toBe(false);
  // The message is the user's guide: in Portuguese, with what to do.
  expect(GIT_MISSING).toContain('Instale o Git');
});
