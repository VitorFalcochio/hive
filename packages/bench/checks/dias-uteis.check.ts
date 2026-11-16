import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addBusinessDays, formatDate } from '../src/dates.ts';

const day = (d: number) => new Date(Date.UTC(2026, 2, d)); // March 2026; the 6th is a Friday.
const plus = (d: number, n: number) => formatDate(addBusinessDays(day(d), n));

test('bench: sábado e domingo não são dias úteis', () => {
  assert.equal(plus(6, 1), '09/03/2026'); // Friday + 1 = Monday
  assert.equal(plus(5, 3), '10/03/2026'); // Thursday + 3 = Tuesday
  assert.equal(plus(7, 1), '09/03/2026'); // Saturday + 1 = Monday
  assert.equal(plus(2, 5), '09/03/2026'); // Monday + 5 = next Monday
  assert.equal(plus(4, 0), '04/03/2026');
});
