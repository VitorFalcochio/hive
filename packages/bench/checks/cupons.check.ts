import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as lib from '../src/index.ts';

test('bench: cupons', () => {
  const api = lib as Record<string, unknown>;
  const applyCoupon = api.applyCoupon as (cart: lib.Cart, code: string) => void;
  const CupomInvalidoError = api.CupomInvalidoError as new (...args: unknown[]) => Error;
  assert.equal(typeof applyCoupon, 'function');
  assert.equal(typeof CupomInvalidoError, 'function');

  const cart = lib.createCart();
  lib.addItem(cart, { sku: 'A', name: 'A', priceCents: 5000, quantity: 1 });
  applyCoupon(cart, 'bemvindo10');
  assert.equal(lib.discount(cart), 500);
  assert.equal(lib.shipping(cart), 1990);

  const free = lib.createCart();
  lib.addItem(free, { sku: 'A', name: 'A', priceCents: 5000, quantity: 1 });
  applyCoupon(free, 'FreteGratis');
  assert.equal(lib.shipping(free), 0);
  assert.equal(lib.discount(free), 0);
  assert.equal(lib.total(free), 5000);

  assert.throws(
    () => applyCoupon(cart, 'NAOEXISTE'),
    (error: unknown) => error instanceof CupomInvalidoError && error instanceof Error,
  );
});
