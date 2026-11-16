import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addBusinessDays, formatDate } from '../src/dates.ts';

test('soma dias úteis no meio da semana', () => {
  // 2026-03-02 is a Monday.
  assert.equal(formatDate(addBusinessDays(new Date(Date.UTC(2026, 2, 2)), 2)), '04/03/2026');
});
