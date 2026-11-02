import assert from 'node:assert/strict';
import test from 'node:test';
import { formatMinorCurrency } from './currency.ts';

test('formats minor units using each currency standard fraction precision', () => {
  assert.equal(
    formatMinorCurrency(2500, 'GEL', 'en-US'),
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'GEL' }).format(25)
  );
  assert.equal(
    formatMinorCurrency(1234, 'JPY', 'en-US'),
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'JPY' }).format(1234)
  );
  assert.equal(
    formatMinorCurrency(1234, 'KWD', 'en-US'),
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'KWD' }).format(1.234)
  );
});

test('fails closed for invalid monetary values and currency codes', () => {
  assert.equal(formatMinorCurrency(-1, 'GEL', 'en-US'), null);
  assert.equal(formatMinorCurrency(Number.MAX_SAFE_INTEGER + 1, 'GEL', 'en-US'), null);
  assert.equal(formatMinorCurrency(100, 'gel', 'en-US'), null);
  assert.equal(formatMinorCurrency(100, 'US', 'en-US'), null);
});
