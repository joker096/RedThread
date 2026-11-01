import test from 'node:test';
import assert from 'node:assert/strict';
import { canInteract } from './identityAccessPolicy.js';

test('women are not blocked by male identity gate', () => {
  assert.equal(canInteract({ gender: 'female', status: null, environment: null }), true);
});

test('men require live verified state; sandbox never grants access', () => {
  assert.equal(canInteract({ gender: 'male', status: null, environment: null }), false);
  assert.equal(canInteract({ gender: 'male', status: 'pending', environment: 'live' }), false);
  assert.equal(canInteract({ gender: 'male', status: 'verified', environment: 'sandbox' }), false);
  assert.equal(canInteract({ gender: 'male', status: 'rejected', environment: 'live' }), false);
  assert.equal(canInteract({ gender: 'male', status: 'verified', environment: 'live' }), true);
});

test('unknown gender fails closed', () => {
  assert.equal(canInteract({ gender: 'unknown', status: 'verified', environment: 'live' }), false);
});
