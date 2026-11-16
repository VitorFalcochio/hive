import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as lib from '../src/index.ts';

test('bench: CSV ida e volta', () => {
  const api = lib as Record<string, unknown>;
  const toCsv = api.toCsv as (products: lib.Product[]) => string;
  const fromCsv = api.fromCsv as (text: string) => lib.Product[];
  assert.equal(typeof toCsv, 'function');
  assert.equal(typeof fromCsv, 'function');
  const products: lib.Product[] = [
    { sku: 'A1', name: 'Caneca', priceCents: 3990, category: 'cozinha' },
    { sku: 'B2', name: 'Camiseta, azul', priceCents: 5990, category: 'roupas' },
    { sku: 'C3', name: 'Quadro "Pôr do sol"', priceCents: 12000, category: 'decoração' },
    { sku: 'D4', name: 'Kit\ncom duas linhas', priceCents: 0, category: 'kits' },
  ];
  const csv = toCsv(products);
  assert.equal(csv.split(/\r?\n/)[0], 'sku,name,priceCents,category');
  assert.ok(csv.includes('"Camiseta, azul"'));
  assert.ok(csv.includes('"Quadro ""Pôr do sol"""'));
  assert.deepEqual(fromCsv(csv), products);
  assert.deepEqual(fromCsv(toCsv([])), []);
});
