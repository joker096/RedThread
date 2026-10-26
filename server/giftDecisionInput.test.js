import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGiftDecisionInput } from './giftDecisionInput.js';

const reference = 'gift_0123456789abcdef0123456789abcdef';

test('accepts only explicit accept and decline decisions', () => {
  assert.deepEqual(validateGiftDecisionInput({ action: 'accept' }, reference), {
    valid: true, action: 'accept', publicReference: reference
  });
  assert.equal(validateGiftDecisionInput({ action: 'decline' }, reference).valid, true);
});

test('rejects missing, malformed, array, and extra-field bodies', () => {
  for (const body of [null, undefined, [], 'accept', {}, { action: 'maybe' }, { action: 'accept', recipientId: 'attacker' }]) {
    assert.equal(validateGiftDecisionInput(body, reference).valid, false);
  }
});

test('does not accept malformed or non-string public references', () => {
  for (const value of [null, '', 'gift_123', 'gift_' + 'g'.repeat(32), 42]) {
    const result = validateGiftDecisionInput({ action: 'accept' }, value);
    assert.equal(result.valid, false);
    assert.equal(result.notFound, true);
    assert.equal(result.error, 'gift_request_not_available');
  }
});
