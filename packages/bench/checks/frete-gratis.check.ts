import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addItem, createCart, shipping } from '../src/cart.ts';

const cartOf = (cents: number) => {
  const cart = createCart();
  addItem(cart, { sku: 'A', name: 'A', priceCents: cents, quantity: 1 });
  return cart;
};

test('bench: frete grátis a partir de R$ 200', () => {
  assert.equal(shipping(cartOf(15000)), 1990);
  assert.equal(shipping(cartOf(19999)), 1990);
  assert.equal(shipping(cartOf(20000)), 0);
  assert.equal(shipping(cartOf(25000)), 0);
});
