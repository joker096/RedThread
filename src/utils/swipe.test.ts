import test from 'node:test';
import assert from 'node:assert/strict';
import { getSwipeActionFromDelta } from './swipe.ts';

test('right swipe sends a like', () => {
  assert.equal(getSwipeActionFromDelta(81), 'like');
  assert.equal(getSwipeActionFromDelta(80), 'like');
});

test('left swipe passes the profile', () => {
  assert.equal(getSwipeActionFromDelta(-81), 'pass');
  assert.equal(getSwipeActionFromDelta(-80), 'pass');
});

test('small and invalid gestures do nothing', () => {
  assert.equal(getSwipeActionFromDelta(79), 'none');
  assert.equal(getSwipeActionFromDelta(-79), 'none');
  assert.equal(getSwipeActionFromDelta(Number.NaN), 'none');
  assert.equal(getSwipeActionFromDelta(Number.POSITIVE_INFINITY), 'none');
});

test('invalid thresholds do not trigger actions', () => {
  assert.equal(getSwipeActionFromDelta(100, -1), 'none');
  assert.equal(getSwipeActionFromDelta(100, Number.NaN), 'none');
});
