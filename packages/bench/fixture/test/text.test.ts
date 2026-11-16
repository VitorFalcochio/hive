import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slugify, titleCase } from '../src/text.ts';

test('slugify junta palavras com hífen', () => {
  assert.equal(slugify('Camiseta Azul 2024'), 'camiseta-azul-2024');
  assert.equal(slugify('  Promo!!  '), 'promo');
});

test('titleCase', () => {
  assert.equal(titleCase('caneca GRANDE'), 'Caneca Grande');
});
