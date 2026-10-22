import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUnreadCount } from './NotificationCenterPanel.tsx';

test('accepts non-negative safe unread counts within the display bound', () => {
  assert.equal(normalizeUnreadCount(0, 4), 0);
  assert.equal(normalizeUnreadCount(20, 4), 20);
  assert.equal(normalizeUnreadCount(1_000_000, 4), 1_000_000);
});

test('falls back to the locally known unread count for invalid API values', () => {
  for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '12', null, {}, []]) {
    assert.equal(normalizeUnreadCount(value, 3), 3, `should reject ${String(value)}`);
  }
});

test('caps an excessive fallback and rejects invalid fallback values', () => {
  assert.equal(normalizeUnreadCount('invalid', 9_000_000), 1_000_000);
  assert.equal(normalizeUnreadCount('invalid', -1), 0);
  assert.equal(normalizeUnreadCount('invalid', Number.NaN), 0);
});
