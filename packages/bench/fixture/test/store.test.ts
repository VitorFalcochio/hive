import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStore, getProduct, productsByCategory } from '../src/store.ts';

const store = createStore([
  { sku: 'A1', name: 'Caneca', priceCents: 3990, category: 'cozinha' },
  { sku: 'B2', name: 'Camiseta', priceCents: 5990, category: 'roupas' },
]);

test('encontra produto pelo SKU', () => {
  assert.equal(getProduct(store, 'A1').name, 'Caneca');
  assert.throws(() => getProduct(store, 'ZZ'));
});

test('filtra por categoria', () => {
  assert.deepEqual(
    productsByCategory(store, 'roupas').map((p) => p.sku),
    ['B2'],
  );
});
