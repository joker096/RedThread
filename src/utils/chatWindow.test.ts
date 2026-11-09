import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_WINDOW_HOURS, isChatWindowExpired } from './chatWindow.ts';

test('chat lifecycle uses a 72-hour window', () => {
  assert.equal(CHAT_WINDOW_HOURS, 72);
});

test('chat window remains open before expiry and closes at the exact boundary', () => {
  const expiry = '2026-11-12T12:00:00.000Z';
  assert.equal(isChatWindowExpired(expiry, Date.parse('2026-11-12T11:59:59.999Z')), false);
  assert.equal(isChatWindowExpired(expiry, Date.parse(expiry)), true);
  assert.equal(isChatWindowExpired(expiry, Date.parse('2026-11-12T12:00:00.001Z')), true);
});

test('invalid expiry values fail open for display logic but server remains authoritative', () => {
  assert.equal(isChatWindowExpired(null, Date.now()), false);
  assert.equal(isChatWindowExpired('not-a-date', Date.now()), false);
  assert.equal(isChatWindowExpired('2026-11-12T12:00:00.000Z', Number.NaN), false);
});
