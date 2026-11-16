import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slugify } from '../src/text.ts';

test('bench: slugify remove acentos', () => {
  assert.equal(slugify('Ação Rápida'), 'acao-rapida');
  assert.equal(slugify('Coração de Mãe!'), 'coracao-de-mae');
  assert.equal(slugify('  Já é  '), 'ja-e');
  assert.equal(slugify('ÉPICO Ônibus Über'), 'epico-onibus-uber');
  assert.equal(slugify('Camiseta Azul 2024'), 'camiseta-azul-2024');
  assert.equal(slugify('  Promo!!  '), 'promo');
});
