import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGiftReceivingPayload } from './GiftReceivingPreferencesPanel.tsx';

test('gift preference payload accepts an explicit boolean setting', () => {
  assert.deepEqual(normalizeGiftReceivingPayload({ requestsEnabled: true }), { requestsEnabled: true });
  assert.deepEqual(normalizeGiftReceivingPayload({ requestsEnabled: false }), { requestsEnabled: false });
});

test('gift preference payload fails closed for malformed or missing values', () => {
  assert.deepEqual(normalizeGiftReceivingPayload(null), { requestsEnabled: false });
  assert.deepEqual(normalizeGiftReceivingPayload({}), { requestsEnabled: false });
  assert.deepEqual(normalizeGiftReceivingPayload({ requestsEnabled: 'true' }), { requestsEnabled: false });
  assert.deepEqual(normalizeGiftReceivingPayload([]), { requestsEnabled: false });
});
