import test from 'node:test';
import assert from 'node:assert/strict';
import { canReserveDiditFreeSession, DIDIT_FREE_MONTHLY_SESSION_LIMIT } from './diditQuota.js';

test('Vow reserves no more than 500 live Didit sessions per UTC month', () => {
  assert.equal(DIDIT_FREE_MONTHLY_SESSION_LIMIT, 500);
  assert.equal(canReserveDiditFreeSession(0), true);
  assert.equal(canReserveDiditFreeSession(499), true);
  assert.equal(canReserveDiditFreeSession(500), false);
  assert.equal(canReserveDiditFreeSession(501), false);
  assert.equal(canReserveDiditFreeSession(-1), false);
  assert.equal(canReserveDiditFreeSession(1.5), false);
  assert.equal(canReserveDiditFreeSession(Number.MAX_SAFE_INTEGER + 1), false);
});
