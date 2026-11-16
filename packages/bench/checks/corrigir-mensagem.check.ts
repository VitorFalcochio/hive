import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStore, getProduct } from '../src/store.ts';

test('bench: mensagem com acento', () => {
  const store = createStore([]);
  assert.throws(() => getProduct(store, 'X9'), { message: 'Produto não encontrado: X9' });
});
