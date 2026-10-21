import { describe, expect, it } from 'vitest';
import { anchorKey, anchorOf, loadDraft, parsePatch, saveDraft } from './review';

const patch = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 111..222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,3 @@ export function app() {',
  ' const a = 1;',
  '-const cor = "azul";',
  '+const cor = "verde";',
  ' export { a };',
  '\\ No newline at end of file',
  'diff --git a/novo.md b/novo.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/novo.md',
  '@@ -0,0 +1 @@',
  '+# Novo',
  'diff --git a/logo.png b/logo.png',
  'Binary files /dev/null and b/logo.png differ',
].join('\n');

describe('parsePatch', () => {
  it('numbers old and new lines per file', () => {
    const files = parsePatch(patch);
    expect(files.map((file) => file.path)).toEqual(['src/app.ts', 'novo.md', 'logo.png']);
    const lines = files[0]!.lines.filter((line) => line.kind !== 'hunk' && line.kind !== 'meta');
    expect(lines.map((line) => [line.kind, line.oldLine, line.newLine, line.text])).toEqual([
      ['ctx', 1, 1, 'const a = 1;'],
      ['del', 2, null, 'const cor = "azul";'],
      ['add', null, 2, 'const cor = "verde";'],
      ['ctx', 3, 3, 'export { a };'],
    ]);
    expect(files[1]!.lines.at(-1)).toMatchObject({ kind: 'add', newLine: 1, text: '# Novo' });
    expect(files[2]!.lines).toEqual([
      { kind: 'meta', text: 'Arquivo binário', oldLine: null, newLine: null },
    ]);
  });

  it('copes with Windows line endings', () => {
    const files = parsePatch(patch.replace(/\n/g, '\r\n'));
    expect(files[0]!.lines.find((line) => line.kind === 'add')?.text).toBe('const cor = "verde";');
  });
});

describe('anchorOf', () => {
  const [file] = parsePatch(patch);
  it('anchors added lines to the new file and removed lines to the old one', () => {
    const removed = file!.lines.find((line) => line.kind === 'del')!;
    const added = file!.lines.find((line) => line.kind === 'add')!;
    expect(anchorOf(file!.path, removed)).toEqual({
      path: 'src/app.ts',
      line: 2,
      side: 'old',
      code: 'const cor = "azul";',
    });
    expect(anchorKey(anchorOf(file!.path, added)!)).toBe('src/app.ts:new:2');
    expect(anchorOf(file!.path, file!.lines[0]!)).toBeNull();
  });
});

describe('review drafts', () => {
  it('keeps unsent notes per task result and forgets empty ones', () => {
    const comment = { path: 'a.ts', line: 1, side: 'new' as const, code: 'x', body: 'Troque' };
    saveDraft('t@1', { comments: [comment], note: '' });
    expect(loadDraft('t@1').comments).toEqual([comment]);
    expect(loadDraft('t@2').comments).toEqual([]);
    saveDraft('t@1', { comments: [], note: ' ' });
    expect(loadDraft('t@1')).toEqual({ comments: [], note: '' });
  });
});
