import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addItem, createCart, discount, setDiscount, total } from '../src/cart.ts';
import { percentOf } from '../src/money.ts';

test('bench: centavos sempre inteiros, meio centavo para cima', () => {
  assert.equal(percentOf(1999, 15), 300);
  assert.equal(percentOf(1000, 10), 100);
  assert.equal(percentOf(5, 10), 1);
  assert.equal(percentOf(3, 10), 0);
  assert.equal(percentOf(10000, 10), 1000);
  const cart = createCart();
  addItem(cart, { sku: 'A', name: 'A', priceCents: 1999, quantity: 1 });
  setDiscount(cart, 15);
  assert.equal(discount(cart), 300);
  assert.equal(total(cart), 1999 - 300 + 1990);
  for (let price = 1; price < 400; price += 7) {
    const other = createCart();
    addItem(other, { sku: 'B', name: 'B', priceCents: price, quantity: 3 });
    setDiscount(other, 17);
    assert.ok(Number.isInteger(total(other)), `total de ${price}`);
  }
});
