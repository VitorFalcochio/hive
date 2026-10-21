import { describe, expect, it } from 'vitest';
import type { SearchMatch } from '@hive/core';
import { groupByFile, previewParts } from './search';

const match = (path: string, line: number, text: string, column: number, length: number) =>
  ({ path, line, text, column, length }) satisfies SearchMatch;

describe('groupByFile', () => {
  it('keeps files in the order git reported them, with their lines together', () => {
    const groups = groupByFile([
      match('b.ts', 3, 'x', 1, 1),
      match('a.ts', 1, 'x', 1, 1),
      match('b.ts', 9, 'x', 1, 1),
    ]);
    expect(groups.map((group) => [group.path, group.matches.map((item) => item.line)])).toEqual([
      ['b.ts', [3, 9]],
      ['a.ts', [1]],
    ]);
  });
});

describe('previewParts', () => {
  it('drops the indentation and splits out the match', () => {
    expect(previewParts(match('a.ts', 1, '    const ação = 1;', 11, 4))).toEqual({
      before: 'const ',
      hit: 'ação',
      after: ' = 1;',
    });
  });

  it('shows the line without a highlight when the match was not located', () => {
    expect(previewParts(match('a.ts', 1, '  texto', 1, 0))).toEqual({
      before: '',
      hit: '',
      after: 'texto',
    });
  });
});
