import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeProject, renderTree, summarizePackageJson } from './project-context';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function project(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hive-context-'));
  folders.push(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

describe('contexto do projeto para a Queen', () => {
  it('lê README, notas para agentes, package.json e a árvore sem o que o Git ignora', async () => {
    const root = await project({
      'README.md': '# Crew\nApp de escalas.',
      'AGENTS.md': 'Rode pnpm test antes de concluir.',
      'package.json': JSON.stringify({
        name: 'crew',
        scripts: { test: 'vitest run', build: 'vite build' },
        dependencies: { react: '^19' },
      }),
      '.gitignore': 'dist/\n',
      'src/app.tsx': '',
      'src/api/routes.ts': '',
      'dist/bundle.js': '',
    });
    const context = await describeProject(root, { name: 'crew', branch: 'main' });
    expect(context).toContain('Repository: crew\nBranch: main');
    expect(context).toContain('App de escalas.');
    expect(context).toContain('Rode pnpm test antes de concluir.');
    expect(context).toContain('  test: vitest run');
    expect(context).toContain('dependencies: react');
    expect(context).toContain('src/');
    expect(context).toContain('  app.tsx');
    expect(context).not.toContain('bundle.js');
    // The README comes before the tree, so a long tree is what gets cut.
    expect(context.indexOf('App de escalas.')).toBeLessThan(context.indexOf('### Files'));
  });

  it('resume pastas fundas e listas longas', () => {
    const files = [
      'a/b/c/d.ts',
      'a/b/c/e.ts',
      ...Array.from({ length: 30 }, (_, index) => `many/f${String(index).padStart(2, '0')}.ts`),
    ];
    const tree = renderTree(files);
    expect(tree).toContain('a/');
    expect(tree).toContain('  b/');
    expect(tree).toContain('    c/ (2 arquivos)');
    expect(tree).toContain('  … +5 itens');
  });

  it('ignora package.json quebrado', () => {
    expect(summarizePackageJson('{ não é json')).toBeNull();
  });
});
