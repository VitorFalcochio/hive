import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { locateElement, needlesOf, projectPath } from './locate';

async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hive-locate-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, windowsHide: true });
  await mkdir(path.join(root, 'src', 'components'), { recursive: true });
  await writeFile(
    path.join(root, 'src', 'components', 'Header.tsx'),
    [
      'export function Header() {',
      '  return (',
      '    <header>',
      '      <button className="btn primary">Salvar alterações</button>',
      '    </header>',
      '  );',
      '}',
    ].join('\n'),
  );
  // Mentions one class only: a weaker match than Header.tsx.
  await writeFile(path.join(root, 'src', 'Other.tsx'), 'export const x = <i className="btn" />;\n');
  await writeFile(path.join(root, 'src', 'styles.css'), '.btn.primary { color: red; }\n');
  return root;
}

const hint = {
  tag: 'button',
  id: null,
  classes: ['btn', 'primary'],
  text: 'Salvar alterações',
  source: null,
};

describe('locateElement', { timeout: 30_000 }, () => {
  it('ranks the file that has the text and the classes first, with the text line', async () => {
    const root = await project();
    const [first, second] = await locateElement(root, hint);
    expect(first).toMatchObject({ path: 'src/components/Header.tsx', line: 4, reason: 'match' });
    expect(second?.path).toBe('src/Other.tsx');
    // Styles are not markup, so the CSS file is not suggested.
    const all = await locateElement(root, hint);
    expect(all.map((item) => item.path)).not.toContain('src/styles.css');
  });

  it('puts the location reported by a dev build first', async () => {
    const root = await project();
    const reported = path.join(root, 'src', 'Other.tsx');
    const [first] = await locateElement(root, { ...hint, source: { file: reported, line: 1 } });
    expect(first).toMatchObject({ path: 'src/Other.tsx', line: 1, reason: 'framework' });
  });

  it('returns nothing when no file mentions the element', async () => {
    const root = await project();
    expect(await locateElement(root, { ...hint, classes: [], text: 'nada parecido' })).toEqual([]);
  });
});

describe('projectPath', { timeout: 30_000 }, () => {
  it('reads absolute, URL and relative paths, and rejects files outside the project', async () => {
    const root = await project();
    const file = path.join(root, 'src', 'Other.tsx');
    expect(await projectPath(root, file)).toBe('src/Other.tsx');
    expect(await projectPath(root, 'http://localhost:5173/src/Other.tsx?t=123')).toBe(
      'src/Other.tsx',
    );
    expect(await projectPath(root, '/src/Other.tsx')).toBe('src/Other.tsx');
    expect(await projectPath(root, './src/Other.tsx')).toBe('src/Other.tsx');
    expect(await projectPath(root, path.join(os.tmpdir(), 'elsewhere.tsx'))).toBeNull();
    expect(await projectPath(root, 'src/missing.tsx')).toBeNull();
  });
});

describe('needlesOf', () => {
  it('skips text that is too long to come from one file and very short classes', () => {
    const needles = needlesOf({ ...hint, text: 'x'.repeat(200), classes: ['p', 'card', 'card'] });
    expect(needles).toEqual([{ text: 'card', weight: 1 }]);
  });
});
