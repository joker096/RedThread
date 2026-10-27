import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNotifications, normalizeUnreadCount } from './NotificationCenterPanel.tsx';

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

test('normalizes valid notification fields and trims identifiers', () => {
  assert.deepEqual(normalizeNotifications([{
    id: ' notification-1 ',
    type: 'new_match',
    createdAt: '2026-10-22T12:00:00Z',
    readAt: null
  }]), [{
    id: 'notification-1',
    type: 'new_match',
    createdAt: '2026-10-22T12:00:00Z',
    readAt: null
  }]);
});

test('accepts privacy-safe gift-request notifications and discards metadata', () => {
  const notification = {
    id: 'gift-notification-1',
    type: 'gift_request',
    createdAt: '2026-10-27T12:00:00Z',
    readAt: null,
    metadata: { orderReference: 'gift_0123456789abcdef0123456789abcdef', recipientCity: 'private' }
  };
  assert.deepEqual(normalizeNotifications([notification]), [{
    id: notification.id,
    type: notification.type,
    createdAt: notification.createdAt,
    readAt: null
  }]);
});

test('rejects malformed notifications and duplicate identifiers', () => {
  const valid = { id: 'n1', type: 'new_message', createdAt: '2026-10-22T12:00:00Z', readAt: null };
  assert.deepEqual(normalizeNotifications([
    null,
    [],
    { ...valid, id: ' ' },
    { ...valid, type: 'unknown' },
    { ...valid, createdAt: 'bad-date' },
    { ...valid, readAt: 42 },
    valid,
    { ...valid, id: ' n1 ', type: 'new_match' }
  ]), [valid]);
  assert.deepEqual(normalizeNotifications(null), []);
  assert.deepEqual(normalizeNotifications({ notifications: [valid] }), []);
});

test('caps notification input to the first twenty items and rejects oversized fields', () => {
  const valid = (id: string) => ({
    id,
    type: 'new_message',
    createdAt: '2026-10-22T12:00:00Z',
    readAt: null
  });
  assert.equal(normalizeNotifications(Array.from({ length: 25 }, (_, i) => valid(`n${i}`))).length, 20);
  assert.deepEqual(normalizeNotifications([
    valid('x'.repeat(257)),
    valid('n2'),
    { ...valid('n3'), createdAt: 'x'.repeat(101) },
    { ...valid('n4'), readAt: '2026-10-22T12:00:00Z'.padEnd(101, ' ') }
  ]), [valid('n2')]);
});


test('accepts the maximum notification identifier length and valid read timestamps', () => {
  const id = 'n'.repeat(256);
  const createdAt = '2026-10-22T12:00:00Z';
  const readAt = '2026-10-22T12:30:00Z';
  assert.deepEqual(normalizeNotifications([{ id, type: 'new_match', createdAt, readAt }]), [
    { id, type: 'new_match', createdAt, readAt }
  ]);
});


test('rejects empty or whitespace-only notification timestamps', () => {
  const valid = { id: 'timestamp-check', type: 'new_message', createdAt: '2026-10-22T12:00:00Z', readAt: null };
  assert.deepEqual(normalizeNotifications([
    { ...valid, createdAt: '' },
    { ...valid, createdAt: '   ' },
    { ...valid, readAt: '' },
    { ...valid, readAt: '   ' }
  ]), []);
});

test('rejects notification timestamps made of tabs and line breaks', () => {
  const valid = { id: 'timestamp-control-whitespace', type: 'new_message', createdAt: '2026-10-22T12:00:00Z', readAt: null };
  for (const timestamp of ['\t\n', '\n\t']) {
    assert.deepEqual(normalizeNotifications([
      { ...valid, createdAt: timestamp },
      { ...valid, readAt: timestamp }
    ]), []);
  }
});
