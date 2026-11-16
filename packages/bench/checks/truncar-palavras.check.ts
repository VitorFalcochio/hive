import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as lib from '../src/index.ts';

test('bench: truncateWords', () => {
  const truncateWords = (lib as Record<string, unknown>).truncateWords as (
    text: string,
    max: number,
  ) => string;
  assert.equal(typeof truncateWords, 'function');
  assert.equal(truncateWords('Caneca azul', 20), 'Caneca azul');
  assert.equal(truncateWords('Caneca azul', 11), 'Caneca azul');
  assert.equal(truncateWords('Caneca de porcelana azul', 15), 'Caneca de…');
  assert.equal(truncateWords('Caneca de porcelana azul', 20), 'Caneca de porcelana…');
  assert.equal(truncateWords('Extraordinariamente', 6), 'Extra…');
  for (let max = 2; max < 30; max++) {
    const out = truncateWords('Um texto qualquer com várias palavras', max);
    assert.ok(out.length <= max, `max ${max}: "${out}"`);
  }
});
