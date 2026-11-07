import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMatchMessageHistoryOptions,
  matchMessageHistoryOrder,
  toChronologicalMessageHistory
} from './matchMessageHistory.js';

test('preserves the existing message-history pagination defaults', () => {
  assert.deepEqual(normalizeMatchMessageHistoryOptions({}), {
    limit: 50,
    offset: 0,
    latest: false,
    beforeCreatedAt: null,
    beforeId: null,
    invalidCursor: false
  });
});

test('bounds message-history pagination and accepts only an explicit latest flag', () => {
  assert.deepEqual(normalizeMatchMessageHistoryOptions({
    limit: '1000',
    offset: '-10',
    latest: 'true'
  }), {
    limit: 100,
    offset: 0,
    latest: true,
    beforeCreatedAt: null,
    beforeId: null,
    invalidCursor: false
  });
  assert.deepEqual(normalizeMatchMessageHistoryOptions({
    limit: 'not-a-number',
    offset: '9000',
    latest: '1'
  }), {
    limit: 50,
    offset: 5000,
    latest: false,
    beforeCreatedAt: null,
    beforeId: null,
    invalidCursor: false
  });
  assert.deepEqual(normalizeMatchMessageHistoryOptions({ limit: '0', offset: '12' }), {
    limit: 50,
    offset: 12,
    latest: false,
    beforeCreatedAt: null,
    beforeId: null,
    invalidCursor: false
  });
});

test('latest-first database pages are returned in chronological display order', () => {
  const newestFirst = [{ id: 'newest' }, { id: 'middle' }, { id: 'oldest' }];
  const chronological = toChronologicalMessageHistory(newestFirst, true);
  assert.deepEqual(chronological, [{ id: 'oldest' }, { id: 'middle' }, { id: 'newest' }]);
  assert.deepEqual(newestFirst, [{ id: 'newest' }, { id: 'middle' }, { id: 'oldest' }]);
  assert.equal(matchMessageHistoryOrder(true), 'DESC');
  assert.equal(matchMessageHistoryOrder(false), 'ASC');
  assert.equal(toChronologicalMessageHistory(newestFirst, false), newestFirst);
});

test('accepts a complete RFC3339 microsecond cursor only in latest mode', () => {
  assert.deepEqual(normalizeMatchMessageHistoryOptions({
    latest: 'true',
    beforeCreatedAt: '2026-11-05T08:00:00.000123Z',
    beforeId: '123e4567-e89b-12d3-a456-426614174000'
  }), {
    limit: 50,
    offset: 0,
    latest: true,
    beforeCreatedAt: '2026-11-05T08:00:00.000123Z',
    beforeId: '123e4567-e89b-12d3-a456-426614174000',
    invalidCursor: false
  });
});

test('rejects partial, malformed, over-precision and legacy-mode cursors', () => {
  const invalidQueries = [
    { latest: 'true', beforeCreatedAt: '2026-11-05T08:00:00.000123Z' },
    { latest: 'true', beforeId: '123e4567-e89b-12d3-a456-426614174000' },
    { latest: 'true', beforeCreatedAt: 'not-a-date', beforeId: 'not-a-uuid' },
    { latest: 'true', beforeCreatedAt: '2026-11-05T08:00:00.0000001Z', beforeId: '123e4567-e89b-12d3-a456-426614174000' },
    { latest: 'true', beforeCreatedAt: '2026-02-31T08:00:00.000123Z', beforeId: '123e4567-e89b-12d3-a456-426614174000' },
    { latest: 'false', beforeCreatedAt: '2026-11-05T08:00:00.000123Z', beforeId: '123e4567-e89b-12d3-a456-426614174000' }
  ];
  for (const query of invalidQueries) {
    const normalized = normalizeMatchMessageHistoryOptions(query);
    assert.equal(normalized.invalidCursor, true, JSON.stringify(query));
    assert.equal(normalized.beforeCreatedAt === null || normalized.beforeId === null || query.latest !== 'true', true);
  }
});

test('does not treat an explicitly empty cursor field as an omitted cursor', () => {
  const normalized = normalizeMatchMessageHistoryOptions({
    latest: 'true',
    beforeCreatedAt: '',
    beforeId: '123e4567-e89b-12d3-a456-426614174000'
  });
  assert.equal(normalized.invalidCursor, true);
  assert.equal(normalized.beforeCreatedAt, null);
});
