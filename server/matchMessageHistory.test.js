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
    beforeId: null
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
    beforeId: null
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
    beforeId: null
  });
  assert.deepEqual(normalizeMatchMessageHistoryOptions({ limit: '0', offset: '12' }), {
    limit: 50,
    offset: 12,
    latest: false,
    beforeCreatedAt: null,
    beforeId: null
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


test('accepts only a complete, valid keyset cursor for older message pages', () => {
  assert.deepEqual(normalizeMatchMessageHistoryOptions({
    latest: 'true',
    beforeCreatedAt: '2026-11-05T08:00:00.000123Z',
    beforeId: '123e4567-e89b-12d3-a456-426614174000'
  }), {
    limit: 50,
    offset: 0,
    latest: true,
    beforeCreatedAt: '2026-11-05T08:00:00.000123Z',
    beforeId: '123e4567-e89b-12d3-a456-426614174000'
  });
  const invalid = normalizeMatchMessageHistoryOptions({
    latest: 'true', beforeCreatedAt: 'not-a-date', beforeId: 'not-a-uuid'
  });
  assert.equal(invalid.beforeCreatedAt, null);
  assert.equal(invalid.beforeId, null);
});
