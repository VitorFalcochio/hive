import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addItem, createCart, shipping, subtotal, total } from '../src/cart.ts';

test('soma itens e cobra frete abaixo do mínimo', () => {
  const cart = createCart();
  addItem(cart, { sku: 'A1', name: 'Caneca', priceCents: 3990, quantity: 2 });
  assert.equal(subtotal(cart), 7980);
  assert.equal(shipping(cart), 1990);
  assert.equal(total(cart), 9970);
});

test('recusa mais itens que o limite', () => {
  const cart = createCart();
  assert.throws(() => addItem(cart, { sku: 'A1', name: 'Caneca', priceCents: 100, quantity: 51 }));
});
