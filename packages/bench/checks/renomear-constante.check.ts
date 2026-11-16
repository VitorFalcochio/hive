import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import * as config from '../src/config.ts';
import { addItem, createCart } from '../src/cart.ts';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

test('bench: MAX_ITEMS substitui MAX_ITENS', () => {
  assert.equal((config as Record<string, unknown>).MAX_ITEMS, 50);
  assert.equal((config as Record<string, unknown>).MAX_ITENS, undefined);
  for (const file of [...files('src'), ...files('test')]) {
    if (file.includes('zz-bench')) continue;
    assert.ok(!readFileSync(file, 'utf8').includes('MAX_ITENS'), `${file} ainda cita MAX_ITENS`);
  }
  const cart = createCart();
  assert.throws(() => addItem(cart, { sku: 'A', name: 'A', priceCents: 1, quantity: 51 }));
  addItem(cart, { sku: 'A', name: 'A', priceCents: 1, quantity: 50 });
});
