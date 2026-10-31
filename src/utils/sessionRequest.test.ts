import test from 'node:test';
import assert from 'node:assert/strict';
import { isCurrentSessionRequest } from './sessionRequest.ts';

test('only the latest request epoch may update session-scoped UI', () => {
  assert.equal(isCurrentSessionRequest(0, 0), true);
  assert.equal(isCurrentSessionRequest(8, 8), true);
  assert.equal(isCurrentSessionRequest(7, 8), false);
  assert.equal(isCurrentSessionRequest(8, 9), false);
  assert.equal(isCurrentSessionRequest(-1, 0), false);
  assert.equal(isCurrentSessionRequest(Number.NaN, 0), false);
  assert.equal(isCurrentSessionRequest(0, Number.POSITIVE_INFINITY), false);
});
