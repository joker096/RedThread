import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deduplicateById,
  normalizeServerMatch,
  normalizeServerMessage,
  normalizeUserId
} from './ServerMatchesPanel.tsx';

test('normalizes bounded match fields and safely handles optional location/message values', () => {
  assert.deepEqual(normalizeServerMatch({
    id: ' match-1 ', partnerId: ' user-2 ', displayName: ' Alex ', age: 32.9,
    country: ' Country '.repeat(20), city: ' City ', lastMessage: ' Hello ',
    lastMessageAt: '2026-10-22T12:00:00Z'
  }), {
    id: 'match-1', partnerId: 'user-2', displayName: 'Alex', age: 32,
    country: ' Country '.repeat(20).trim().slice(0, 100), city: 'City',
    lastMessage: 'Hello', lastMessageAt: '2026-10-22T12:00:00Z'
  });
  assert.deepEqual(normalizeServerMatch({
    id: 'match-2', partnerId: 'user-3', displayName: 'Sam', age: 18,
    country: null, city: 42, lastMessage: {}, lastMessageAt: 'not-a-date'
  }), {
    id: 'match-2', partnerId: 'user-3', displayName: 'Sam', age: 18,
    country: '', city: '', lastMessage: null, lastMessageAt: null
  });
});

test('rejects malformed matches and invalid age or oversized required fields', () => {
  assert.equal(normalizeServerMatch(null), null);
  assert.equal(normalizeServerMatch([]), null);
  const base = { id: '1', partnerId: '2', displayName: 'Alex', age: 30 };
  for (const age of [17, 121, Number.NaN, Number.POSITIVE_INFINITY, '30']) {
    assert.equal(normalizeServerMatch({ ...base, age }), null);
  }
  assert.equal(normalizeServerMatch({ ...base, id: ' '.repeat(257) }), null);
  assert.equal(normalizeServerMatch({ ...base, partnerId: 'p'.repeat(257) }), null);
  assert.equal(normalizeServerMatch({ ...base, displayName: 'x'.repeat(101) }), null);
});

test('bounds optional match location and last-message fields', () => {
  const match = normalizeServerMatch({
    id: 'match-1', partnerId: 'user-1', displayName: 'Alex', age: 25,
    country: 'C'.repeat(150), city: 'T'.repeat(150),
    lastMessage: 'x'.repeat(1200), lastMessageAt: '2026-10-22T12:00:00Z'.padEnd(101, ' ')
  });
  assert.equal(match?.country.length, 100);
  assert.equal(match?.city.length, 100);
  assert.equal(match?.lastMessage?.length, 1000);
  assert.equal(match?.lastMessageAt, null);
});

test('normalizes message payloads and rejects malformed messages', () => {
  assert.deepEqual(normalizeServerMessage({
    id: ' msg-1 ', senderId: ' user-1 ', text: ' hello ', createdAt: '2026-10-22T12:00:00Z'
  }), {
    id: 'msg-1', senderId: 'user-1', text: ' hello ', createdAt: '2026-10-22T12:00:00Z'
  });
  assert.equal(normalizeServerMessage(null), null);
  assert.equal(normalizeServerMessage([]), null);
  assert.equal(normalizeServerMessage({ id: '1', senderId: '2', text: '  ', createdAt: '2026-10-22T12:00:00Z' }), null);
  assert.equal(normalizeServerMessage({ id: '1', senderId: '2', text: 'x'.repeat(10001), createdAt: '2026-10-22T12:00:00Z' }), null);
  assert.equal(normalizeServerMessage({ id: '1', senderId: '2', text: 'hello', createdAt: 'bad-date' }), null);
});

test('enforces message identifier and timestamp length limits', () => {
  const base = { id: 'm'.repeat(256), senderId: 'u'.repeat(256), text: 'hello', createdAt: '2026-10-22T12:00:00Z' };
  assert.equal(normalizeServerMessage(base)?.id, 'm'.repeat(256));
  assert.equal(normalizeServerMessage(base)?.senderId, 'u'.repeat(256));
  assert.equal(normalizeServerMessage({ ...base, id: 'm'.repeat(257) }), null);
  assert.equal(normalizeServerMessage({ ...base, senderId: 'u'.repeat(257) }), null);
  assert.equal(normalizeServerMessage({ ...base, createdAt: '2026-10-22T12:00:00Z'.padEnd(101, ' ') }), null);
});

test('normalizes user identifiers and preserves only the first item per id', () => {
  assert.equal(normalizeUserId(' user-1 '), 'user-1');
  assert.equal(normalizeUserId('   '), null);
  assert.equal(normalizeUserId('x'.repeat(257)), null);
  assert.equal(normalizeUserId(1), null);
  assert.deepEqual(deduplicateById([{ id: 'a', value: 1 }, { id: 'b', value: 2 }, { id: 'a', value: 3 }]), [
    { id: 'a', value: 1 }, { id: 'b', value: 2 }
  ]);
});
