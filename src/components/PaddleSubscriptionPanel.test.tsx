import test from 'node:test';
import assert from 'node:assert/strict';
import { isCurrentPaddleSessionAction } from './PaddleSubscriptionPanel.tsx';

test('Paddle actions are valid only for the authenticated session that started them', () => {
  assert.equal(isCurrentPaddleSessionAction(0, 0), true);
  assert.equal(isCurrentPaddleSessionAction(4, 4), true);
  assert.equal(isCurrentPaddleSessionAction(3, 4), false);
  assert.equal(isCurrentPaddleSessionAction(4, 5), false);
  assert.equal(isCurrentPaddleSessionAction(Number.NaN, 4), false);
  assert.equal(isCurrentPaddleSessionAction(4, Number.POSITIVE_INFINITY), false);
});
