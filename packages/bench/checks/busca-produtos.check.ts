import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as lib from '../src/index.ts';

type Search = (
  store: lib.Store,
  query: string,
  options?: { category?: string; sort?: 'price-asc' | 'price-desc' },
) => lib.Product[];

test('bench: searchProducts', () => {
  const search = (lib as Record<string, unknown>).searchProducts as Search;
  assert.equal(typeof search, 'function');
  const store = lib.createStore([
    { sku: 'C1', name: 'Café Especial', priceCents: 4500, category: 'mercado' },
    { sku: 'K1', name: 'caneca de café', priceCents: 3990, category: 'cozinha' },
    { sku: 'K2', name: 'Caneca Térmica', priceCents: 8900, category: 'cozinha' },
    { sku: 'R1', name: 'Camiseta', priceCents: 5990, category: 'roupas' },
  ]);
  const skus = (list: lib.Product[]) => list.map((p) => p.sku);
  assert.deepEqual(skus(search(store, 'cafe')), ['C1', 'K1']);
  assert.deepEqual(skus(search(store, 'CANECA')), ['K1', 'K2']);
  assert.deepEqual(skus(search(store, 'termica')), ['K2']);
  assert.deepEqual(skus(search(store, 'café', { category: 'cozinha' })), ['K1']);
  assert.deepEqual(skus(search(store, '', { sort: 'price-desc' })), ['K2', 'R1', 'C1', 'K1']);
  assert.deepEqual(skus(search(store, 'ca', { sort: 'price-asc' })), ['K1', 'C1', 'R1', 'K2']);
  assert.deepEqual(skus(search(store, '')), ['C1', 'K1', 'K2', 'R1']);
  assert.deepEqual(skus(search(store, 'xyz')), []);
});
