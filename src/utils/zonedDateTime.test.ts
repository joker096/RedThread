import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveUniqueLocalDateTime } from './zonedDateTime.ts';

test('resolves a unique local wall-clock time in the supplied IANA zone', () => {
  const result = resolveUniqueLocalDateTime('2026-11-03T18:30', 'Asia/Tbilisi');
  assert.ok(result);
  assert.equal(result.toISOString(), '2026-11-03T14:30:00.000Z');
});

test('rejects a local time skipped by a daylight-saving transition', () => {
  assert.equal(resolveUniqueLocalDateTime('2026-03-08T02:30', 'America/New_York'), null);
});

test('rejects a local time repeated by a daylight-saving transition', () => {
  assert.equal(resolveUniqueLocalDateTime('2026-11-01T01:30', 'America/New_York'), null);
});

test('accepts an unambiguous time after a daylight-saving transition', () => {
  const result = resolveUniqueLocalDateTime('2026-11-01T03:30', 'America/New_York');
  assert.ok(result);
  assert.equal(result.toISOString(), '2026-11-01T08:30:00.000Z');
});

test('rejects malformed values and invalid time zones', () => {
  assert.equal(resolveUniqueLocalDateTime('2026-02-30T12:00', 'Asia/Tbilisi'), null);
  assert.equal(resolveUniqueLocalDateTime('2026-11-03T18:30', 'Not/A_Real_Zone'), null);
});
