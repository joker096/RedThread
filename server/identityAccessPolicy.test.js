import test from 'node:test';
import assert from 'node:assert/strict';
import { canInteract } from './identityAccessPolicy.js';

const activeL3 = {
  l3Status: 'approved',
  l3ExpiresAt: '2027-01-01T00:00:00.000Z',
  now: Date.parse('2026-11-01T00:00:00.000Z')
};

test('women are not blocked by the male identity gate', () => {
  assert.equal(canInteract({ gender: 'female', status: null, environment: null }), true);
});

test('men require live verified L2 and an approved, unexpired L3 decision', () => {
  assert.equal(canInteract({ gender: 'male', status: 'verified', environment: 'live', ...activeL3 }), true);
  for (const input of [
    { status: null, environment: null, ...activeL3 },
    { status: 'pending', environment: 'live', ...activeL3 },
    { status: 'verified', environment: 'sandbox', ...activeL3 },
    { status: 'rejected', environment: 'live', ...activeL3 },
    { status: 'verified', environment: 'live' },
    { status: 'verified', environment: 'live', l3Status: 'pending', l3ExpiresAt: activeL3.l3ExpiresAt },
    { status: 'verified', environment: 'live', l3Status: 'rejected', l3ExpiresAt: activeL3.l3ExpiresAt },
    { status: 'verified', environment: 'live', l3Status: 'revoked', l3ExpiresAt: activeL3.l3ExpiresAt },
    { status: 'verified', environment: 'live', l3Status: 'approved', l3ExpiresAt: '2026-10-31T23:59:59.999Z', now: activeL3.now },
    { status: 'verified', environment: 'live', l3Status: 'approved', l3ExpiresAt: 'not-a-date', now: activeL3.now },
    { status: 'verified', environment: 'live', l3Status: 'approved', l3ExpiresAt: activeL3.l3ExpiresAt, now: Number.NaN }
  ]) {
    assert.equal(canInteract({ gender: 'male', ...input }), false);
  }
});

test('unknown gender fails closed', () => {
  assert.equal(canInteract({ gender: 'unknown', status: 'verified', environment: 'live', ...activeL3 }), false);
});
