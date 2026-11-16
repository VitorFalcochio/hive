import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatBRL, percentOf } from '../src/money.ts';

test('formata reais com milhar e centavos', () => {
  assert.equal(formatBRL(123456), 'R$ 1.234,56');
  assert.equal(formatBRL(5), 'R$ 0,05');
  assert.equal(formatBRL(-1990), '-R$ 19,90');
});

test('calcula porcentagem', () => {
  assert.equal(percentOf(10000, 10), 1000);
});
