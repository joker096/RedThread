import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { resolvePrivacyRecoveryMappings } from './privacyRecoveryMapping.js';

const key = 'privacy-recovery-test-key-with-at-least-32-bytes';
const id = () => randomUUID();
const ref = value => createHmac('sha256', key).update(value, 'utf8').digest('hex');
const event = (event_type, subjectId, resourceId = null) => ({
  sequence: 1,
  event_id: randomUUID(),
  event_type,
  subject_ref: ref(subjectId),
  resource_ref: resourceId ? ref(resourceId) : null
});

test('maps user and resource references using the ledger HMAC derivation', () => {
  const userId = id();
  const photoId = id();
  const result = resolvePrivacyRecoveryMappings({
    pseudonymKey: key,
    users: [{ id: userId }],
    photos: [{ id: photoId }],
    events: [event('private_photo_erasure_requested', userId, photoId)]
  });
  assert.deepEqual(result, [{
    sequence: 1,
    eventId: result[0].eventId,
    eventType: 'private_photo_erasure_requested',
    status: 'matched',
    subjectUserId: userId,
    resourceId: photoId
  }]);
});

test('maps all resource-bearing event types against their own restored entity sets', () => {
  const userId = id();
  const voiceId = id();
  const orderId = id();
  const result = resolvePrivacyRecoveryMappings({
    pseudonymKey: key,
    users: [{ id: userId }],
    voiceIntros: [{ id: voiceId }],
    giftOrders: [{ id: orderId }],
    events: [
      event('voice_intro_erasure_requested', userId, voiceId),
      event('gift_order_consent_withdrawn', userId, orderId)
    ]
  });
  assert.deepEqual(result.map(item => [item.status, item.resourceId]), [
    ['matched', voiceId],
    ['matched', orderId]
  ]);
});

test('reports missing and ambiguous mappings without guessing', () => {
  const userId = id();
  const photoId = id();
  const events = [
    event('private_photo_erasure_requested', userId, photoId),
    event('account_erasure_requested', id()),
    event('account_erasure_requested', userId)
  ];
  const result = resolvePrivacyRecoveryMappings({
    pseudonymKey: key,
    users: [{ id: userId }, { id: userId }],
    photos: [],
    events
  });
  assert.deepEqual(result.map(item => item.status), [
    'subject_ambiguous',
    'subject_unmatched',
    'subject_ambiguous'
  ]);
  assert.ok(result.every(item => item.subjectUserId === null && item.resourceId === null));
});

test('reports missing required resource reference and never guesses across entity types', () => {
  const userId = id();
  const voiceId = id();
  const result = resolvePrivacyRecoveryMappings({
    pseudonymKey: key,
    users: [{ id: userId }],
    photos: [{ id: voiceId }],
    events: [
      event('voice_intro_erasure_requested', userId),
      event('voice_intro_erasure_requested', userId, voiceId)
    ]
  });
  assert.deepEqual(result.map(item => item.status), [
    'resource_reference_missing',
    'resource_unmatched'
  ]);
});

test('rejects weak keys, malformed candidates and malformed event references', () => {
  assert.throws(() => resolvePrivacyRecoveryMappings({
    pseudonymKey: 'weak', events: []
  }), /mapping_input_invalid/);
  assert.throws(() => resolvePrivacyRecoveryMappings({
    pseudonymKey: key, users: [{ id: 'not-a-uuid' }], events: []
  }), /candidate_invalid/);
  assert.throws(() => resolvePrivacyRecoveryMappings({
    pseudonymKey: key,
    events: [{ event_type: 'account_erasure_requested', subject_ref: 'bad' }]
  }), /mapping_event_invalid/);
});
