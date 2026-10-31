import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGiftRequestInput } from './giftRequestInput.js';

const valid = {
  matchId: 'a5e4a6a0-2a5e-4a22-9a7d-01bcd2345678',
  catalogItemId: 'b5e4a6a0-2a5e-4a22-9a7d-01bcd2345678',
  idempotencyKey: 'gift-request-client-key-001'
};

test('accepts only the minimal gift request contract', () => {
  assert.deepEqual(normalizeGiftRequestInput(valid), { ok: true, value: valid });
});

test('rejects malformed bodies and identifiers', () => {
  assert.equal(normalizeGiftRequestInput(null).error, 'invalid_body');
  assert.equal(normalizeGiftRequestInput([]).error, 'invalid_body');
  assert.equal(normalizeGiftRequestInput({ ...valid, matchId: 'not-a-uuid' }).error, 'invalid_match_id');
  assert.equal(normalizeGiftRequestInput({ ...valid, catalogItemId: '' }).error, 'invalid_catalog_item_id');
  assert.equal(normalizeGiftRequestInput({ ...valid, idempotencyKey: 'short' }).error, 'invalid_idempotency_key');
});

test('rejects sender-supplied recipient, price, consent, payment, and delivery details', () => {
  for (const extra of [
    { recipientId: 'a5e4a6a0-2a5e-4a22-9a7d-01bcd2345678' },
    { priceMinorUnits: 1 },
    { recipientConsent: true },
    { paymentStatus: 'authorized' },
    { address: '1 Example Street' },
    { city: 'Tbilisi' },
    { phone: '+995555000000' }
  ]) {
    assert.equal(normalizeGiftRequestInput({ ...valid, ...extra }).error, 'unexpected_field');
  }
});

test('normalizes UUID casing and preserves the idempotency key', () => {
  const result = normalizeGiftRequestInput({
    ...valid,
    matchId: valid.matchId.toUpperCase(),
    catalogItemId: valid.catalogItemId.toUpperCase()
  });
  assert.equal(result.value.matchId, valid.matchId);
  assert.equal(result.value.catalogItemId, valid.catalogItemId);
  assert.equal(result.value.idempotencyKey, valid.idempotencyKey);
});
