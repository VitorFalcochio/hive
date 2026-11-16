import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as lib from '../src/index.ts';

test('bench: estoque', () => {
  const add = (lib as Record<string, unknown>).addProductToCart as (
    cart: lib.Cart,
    store: lib.Store,
    sku: string,
    quantity: number,
  ) => void;
  assert.equal(typeof add, 'function');
  const store = lib.createStore([
    { sku: 'A', name: 'Caneca', priceCents: 3990, category: 'cozinha', stock: 3 } as lib.Product,
    { sku: 'B', name: 'Camiseta', priceCents: 5990, category: 'roupas' },
  ]);
  const cart = lib.createCart();
  add(cart, store, 'A', 2);
  assert.deepEqual(cart.items[0], { sku: 'A', name: 'Caneca', priceCents: 3990, quantity: 2 });
  assert.throws(() => add(cart, store, 'A', 2));
  add(cart, store, 'A', 1);
  assert.equal(cart.items[0]!.quantity, 3);
  add(cart, store, 'B', 40);
  assert.equal(lib.itemCount(cart), 43);
  assert.throws(() => add(cart, store, 'B', 10)); // cart limit still applies
  assert.throws(() => add(cart, store, 'NOPE', 1));
});
