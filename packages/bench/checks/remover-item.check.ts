import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as lib from '../src/index.ts';

test('bench: removeItem', () => {
  const removeItem = (lib as Record<string, unknown>).removeItem as (
    cart: lib.Cart,
    sku: string,
    quantity: number,
  ) => void;
  assert.equal(typeof removeItem, 'function');
  const cart = lib.createCart();
  lib.addItem(cart, { sku: 'A', name: 'A', priceCents: 100, quantity: 3 });
  lib.addItem(cart, { sku: 'B', name: 'B', priceCents: 200, quantity: 1 });
  removeItem(cart, 'A', 1);
  assert.equal(cart.items.find((i) => i.sku === 'A')?.quantity, 2);
  removeItem(cart, 'A', 2);
  assert.equal(
    cart.items.find((i) => i.sku === 'A'),
    undefined,
  );
  removeItem(cart, 'B', 5);
  assert.equal(cart.items.length, 0);
  assert.throws(() => removeItem(cart, 'Z', 1));
});
