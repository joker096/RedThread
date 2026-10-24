import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGiftReceivingPreferences, serializeGiftReceivingPreferences } from './giftReceivingPreferences.js';

test('gift receiving defaults to off when no persisted preference exists', () => {
  assert.deepEqual(serializeGiftReceivingPreferences(undefined), { requestsEnabled: false });
  assert.deepEqual(serializeGiftReceivingPreferences({ requests_enabled: false }), { requestsEnabled: false });
  assert.deepEqual(serializeGiftReceivingPreferences({ requests_enabled: true }), { requestsEnabled: true });
});

test('gift preference update accepts only an explicit boolean', () => {
  assert.deepEqual(normalizeGiftReceivingPreferences({ requestsEnabled: true }), { ok: true, value: { requestsEnabled: true } });
  assert.deepEqual(normalizeGiftReceivingPreferences({ requestsEnabled: false }), { ok: true, value: { requestsEnabled: false } });
  assert.equal(normalizeGiftReceivingPreferences({}).ok, false);
  assert.equal(normalizeGiftReceivingPreferences({ requestsEnabled: 'true' }).ok, false);
  assert.equal(normalizeGiftReceivingPreferences({ requestsEnabled: true, userId: 'another-user' }).ok, false);
  assert.equal(normalizeGiftReceivingPreferences(null).ok, false);
  assert.equal(normalizeGiftReceivingPreferences([]).ok, false);
});
