import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { runPrivateMediaPrivacyRecovery } from './privacyRecoveryMediaCoordinator.js';

const userId = '123e4567-e89b-42d3-a456-426614174000';
const key = 'recovery-test-key-material-which-is-long-enough';
const subjectRef = createHmac('sha256', key).update(userId, 'utf8').digest('hex');

function poolFor({ events = [], users = [{ id: userId }], voiceIntros = [], photos = [], giftOrders = [] } = {}) {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith('BEGIN TRANSACTION')) return { rows: [] };
      if (sql.includes('current_database()')) return { rows: [{ database_name: 'vow_restore_test', database_role: 'vow_restore_runner' }] };
      if (sql.includes('FROM privacy_recovery_events')) return { rows: events };
      if (sql === 'SELECT id FROM users') return { rows: users };
      if (sql.startsWith('SELECT id, user_id FROM profile_voice_intros')) return { rows: voiceIntros };
      if (sql.startsWith('SELECT id, user_id FROM photo_assets')) return { rows: photos };
      if (sql.startsWith('SELECT id, recipient_id AS user_id FROM gift_delivery_orders')) return { rows: giftOrders };
      if (sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      throw new Error('unexpected_query');
    },
    release() { calls.push('RELEASE'); }
  };
  return { pool: { async connect() { return client; } }, calls };
}

const isolatedEnv = {
  NODE_ENV: 'test',
  PRIVACY_RECOVERY_RESTORE_ISOLATED: 'true',
  PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY: key,
  PRIVACY_RECOVERY_RESTORE_DATABASE_NAME: 'vow_restore_test',
  PRIVACY_RECOVERY_RESTORE_DATABASE_ROLE: 'vow_restore_runner',
  PRIVACY_RECOVERY_RESTORE_CONFIRMATION: 'ISOLATED_RESTORE_ONLY'
};

test('coordinator stops at the first unsupported event without replaying later events', async () => {
  const { pool, calls } = poolFor({
    events: [{
      sequence: '1',
      event_id: '123e4567-e89b-42d3-a456-426614174001',
      event_type: 'ad_consent_revoked',
      subject_ref: subjectRef,
      resource_ref: null
    }, {
      sequence: '2',
      event_id: '123e4567-e89b-42d3-a456-426614174002',
      event_type: 'private_photo_erasure_requested',
      subject_ref: subjectRef,
      resource_ref: 'b'.repeat(64)
    }]
  });
  const result = await runPrivateMediaPrivacyRecovery({
    pool, env: isolatedEnv, snapshotLedgerSequence: 0, throughSequence: 2
  });
  assert.deepEqual(result, {
    complete: false,
    processedCount: 0,
    alreadyAppliedCount: 0,
    blockedSequence: 1,
    blockedEventType: 'ad_consent_revoked',
    throughSequence: 2
  });
  assert.equal(calls.includes('COMMIT'), true);
});

test('coordinator preflights the full batch before applying any supported prefix', async () => {
  const photoId = '123e4567-e89b-42d3-a456-426614174005';
  const photoRef = createHmac('sha256', key).update(photoId, 'utf8').digest('hex');
  const { pool } = poolFor({
    events: [{
      sequence: '1',
      event_id: '123e4567-e89b-42d3-a456-426614174006',
      event_type: 'private_photo_erasure_requested',
      subject_ref: subjectRef,
      resource_ref: photoRef
    }, {
      sequence: '2',
      event_id: '123e4567-e89b-42d3-a456-426614174007',
      event_type: 'ad_consent_revoked',
      subject_ref: subjectRef,
      resource_ref: null
    }],
    photos: [{ id: photoId, user_id: userId }]
  });
  const applied = [];
  const result = await runPrivateMediaPrivacyRecovery({
    pool, env: isolatedEnv, snapshotLedgerSequence: 0, throughSequence: 2,
    applyEvent: async ({ mapping }) => {
      applied.push(mapping);
      return { applied: true, alreadyApplied: false };
    }
  });
  assert.deepEqual(applied, []);
  assert.deepEqual(result, {
    complete: false,
    processedCount: 0,
    alreadyAppliedCount: 0,
    blockedSequence: 2,
    blockedEventType: 'ad_consent_revoked',
    throughSequence: 2
  });
});

test('coordinator preflights the full batch before applying a supported prefix', async () => {
  const photoId = '123e4567-e89b-42d3-a456-426614174005';
  const photoRef = createHmac('sha256', key).update(photoId, 'utf8').digest('hex');
  const { pool } = poolFor({
    events: [{
      sequence: '1',
      event_id: '123e4567-e89b-42d3-a456-426614174006',
      event_type: 'private_photo_erasure_requested',
      subject_ref: subjectRef,
      resource_ref: photoRef
    }, {
      sequence: '2',
      event_id: '123e4567-e89b-42d3-a456-426614174007',
      event_type: 'ad_consent_revoked',
      subject_ref: subjectRef,
      resource_ref: null
    }],
    photos: [{ id: photoId, user_id: userId }]
  });
  const applied = [];
  const result = await runPrivateMediaPrivacyRecovery({
    pool, env: isolatedEnv, snapshotLedgerSequence: 0, throughSequence: 2,
    applyEvent: async ({ mapping }) => {
      applied.push(mapping);
      return { applied: true, alreadyApplied: false };
    }
  });
  assert.deepEqual(applied, []);
  assert.deepEqual(result, {
    complete: false,
    processedCount: 0,
    alreadyAppliedCount: 0,
    blockedSequence: 2,
    blockedEventType: 'ad_consent_revoked',
    throughSequence: 2
  });
});


test('coordinator inventories gift-order recipients but keeps gift withdrawal blocked until its domain executor exists', async () => {
  const recipientId = userId;
  const orderId = '123e4567-e89b-42d3-a456-426614174099';
  const orderRef = createHmac('sha256', key).update(orderId, 'utf8').digest('hex');
  const { pool, calls } = poolFor({
    events: [{
      sequence: '1',
      event_id: '123e4567-e89b-42d3-a456-426614174098',
      event_type: 'gift_order_consent_withdrawn',
      subject_ref: subjectRef,
      resource_ref: orderRef
    }],
    giftOrders: [{ id: orderId, user_id: recipientId }]
  });
  let appliedCount = 0;
  const result = await runPrivateMediaPrivacyRecovery({
    pool,
    env: isolatedEnv,
    snapshotLedgerSequence: 0,
    throughSequence: 1,
    applyEvent: async () => {
      appliedCount += 1;
      return { applied: true, alreadyApplied: false };
    }
  });
  assert.equal(calls.includes('SELECT id, recipient_id AS user_id FROM gift_delivery_orders'), true);
  assert.equal(appliedCount, 0);
  assert.deepEqual(result, {
    complete: false,
    processedCount: 0,
    alreadyAppliedCount: 0,
    blockedSequence: 1,
    blockedEventType: 'gift_order_consent_withdrawn',
    throughSequence: 1
  });
});

test('coordinator rejects an incomplete staged sequence range', async () => {
  const { pool, calls } = poolFor({ events: [] });
  await assert.rejects(
    runPrivateMediaPrivacyRecovery({
      pool, env: isolatedEnv, snapshotLedgerSequence: 10, throughSequence: 11
    }),
    /privacy_recovery_executor_sequence_range_incomplete/
  );
  assert.equal(calls.includes('ROLLBACK'), true);
  assert.equal(calls.includes('COMMIT'), false);
});

test('coordinator requires an explicitly isolated non-production environment', async () => {
  const { pool, calls } = poolFor();
  await assert.rejects(
    runPrivateMediaPrivacyRecovery({
      pool,
      env: { ...isolatedEnv, NODE_ENV: 'production' },
      snapshotLedgerSequence: 0,
      throughSequence: 0
    }),
    /privacy_recovery_executor_requires_isolated_restore/
  );
  assert.equal(calls.length, 0);
});

test('empty verified range completes without touching domain state', async () => {
  const { pool, calls } = poolFor();
  const result = await runPrivateMediaPrivacyRecovery({
    pool, env: isolatedEnv, snapshotLedgerSequence: 25, throughSequence: 25
  });
  assert.deepEqual(result, {
    complete: true,
    processedCount: 0,
    alreadyAppliedCount: 0,
    blockedSequence: null,
    blockedEventType: null,
    throughSequence: 25
  });
  assert.equal(calls.some(sql => sql === 'SELECT id FROM users'), true);
});


test('coordinator delegates unresolved resource mapping to receipt-first executor for safe resume', async () => {
  const resourceId = '123e4567-e89b-42d3-a456-426614174003';
  const resourceRef = createHmac('sha256', key).update(resourceId, 'utf8').digest('hex');
  const { pool } = poolFor({
    events: [{
      sequence: '1',
      event_id: '123e4567-e89b-42d3-a456-426614174004',
      event_type: 'private_photo_erasure_requested',
      subject_ref: subjectRef,
      resource_ref: resourceRef
    }],
    photos: []
  });
  const applied = [];
  const result = await runPrivateMediaPrivacyRecovery({
    pool,
    env: isolatedEnv,
    snapshotLedgerSequence: 0,
    throughSequence: 1,
    applyEvent: async ({ mapping }) => {
      applied.push(mapping);
      assert.equal(mapping.status, 'resource_unmatched');
      return { applied: false, alreadyApplied: true, outcome: 'photo_erasure_queued' };
    }
  });
  assert.equal(applied.length, 1);
  assert.deepEqual(result, {
    complete: true,
    processedCount: 0,
    alreadyAppliedCount: 1,
    blockedSequence: null,
    blockedEventType: null,
    throughSequence: 1
  });
});


test('coordinator blocks every non-media privacy domain before applying any media prefix', async () => {
  const photoId = '123e4567-e89b-42d3-a456-426614174005';
  const photoRef = createHmac('sha256', key).update(photoId, 'utf8').digest('hex');
  const blockedTypes = [
    'profile_data_export_requested',
    'marketing_profile_enrichment_requested'
  ];

  for (const blockedType of blockedTypes) {
    const { pool } = poolFor({
      events: [{
        sequence: '1',
        event_id: '123e4567-e89b-42d3-a456-426614174006',
        event_type: 'private_photo_erasure_requested',
        subject_ref: subjectRef,
        resource_ref: photoRef
      }, {
        sequence: '2',
        event_id: '123e4567-e89b-42d3-a456-426614174007',
        event_type: blockedType,
        subject_ref: subjectRef,
        resource_ref: null
      }],
      photos: [{ id: photoId, user_id: userId }]
    });
    let appliedCount = 0;
    const result = await runPrivateMediaPrivacyRecovery({
      pool,
      env: isolatedEnv,
      snapshotLedgerSequence: 0,
      throughSequence: 2,
      applyEvent: async () => {
        appliedCount += 1;
        return { applied: true, alreadyApplied: false };
      }
    });
    assert.equal(result.complete, false, blockedType);
    assert.equal(result.blockedSequence, 2, blockedType);
    assert.equal(result.blockedEventType, blockedType, blockedType);
    assert.equal(appliedCount, 0, blockedType);
  }
});


test('coordinator replays subject-only L3 consent withdrawal events', async () => {
  const applied = [];
  const { pool } = poolFor({
    events: [{
      sequence: '1',
      event_id: '123e4567-e89b-42d3-a456-426614174000',
      event_type: 'identity_l3_consent_withdrawn',
      subject_ref: subjectRef,
      resource_ref: null
    }]
  });
  const result = await runPrivateMediaPrivacyRecovery({
    pool,
    env: isolatedEnv,
    snapshotLedgerSequence: 0,
    throughSequence: 1,
    applyEvent: async input => {
      applied.push(input.mapping);
      return { applied: true, alreadyApplied: false, outcome: 'identity_l3_consent_withdrawn' };
    }
  });
  assert.equal(result.complete, true);
  assert.equal(result.processedCount, 1);
  assert.deepEqual(applied, [{
    sequence: '1',
    eventId: '123e4567-e89b-42d3-a456-426614174000',
    eventType: 'identity_l3_consent_withdrawn',
    status: 'matched',
    subjectUserId: userId,
    resourceId: null
  }]);
});

test('coordinator dispatches account erasure to the account executor after whole-range preflight', async () => {
  const { pool } = poolFor({
    events: [{
      sequence: '1',
      event_id: '123e4567-e89b-42d3-a456-426614174020',
      event_type: 'account_erasure_requested',
      subject_ref: subjectRef,
      resource_ref: null
    }]
  });
  const applied = [];
  const result = await runPrivateMediaPrivacyRecovery({
    pool, env: isolatedEnv, snapshotLedgerSequence: 0, throughSequence: 1,
    preflightAccountErasure: async () => ({ ready: true, alreadyApplied: false }),
    applyEvent: async ({ mapping }) => {
      applied.push(mapping);
      return { applied: true, alreadyApplied: false, outcome: 'account_erasure_replayed' };
    }
  });
  assert.equal(result.complete, true);
  assert.equal(result.processedCount, 1);
  assert.equal(applied[0].eventType, 'account_erasure_requested');
  assert.equal(applied[0].subjectUserId, userId);
  assert.equal(applied[0].resourceId, null);
});

test('coordinator preflights account erasure before replaying an earlier supported prefix', async () => {
  const photoId = '123e4567-e89b-42d3-a456-426614174021';
  const photoRef = createHmac('sha256', key).update(photoId, 'utf8').digest('hex');
  const { pool } = poolFor({
    events: [{
      sequence: '1',
      event_id: '123e4567-e89b-42d3-a456-426614174022',
      event_type: 'private_photo_erasure_requested',
      subject_ref: subjectRef,
      resource_ref: photoRef
    }, {
      sequence: '2',
      event_id: '123e4567-e89b-42d3-a456-426614174023',
      event_type: 'account_erasure_requested',
      subject_ref: subjectRef,
      resource_ref: null
    }],
    photos: [{ id: photoId, user_id: userId }]
  });
  let preflightCount = 0;
  let applyCount = 0;
  const result = await runPrivateMediaPrivacyRecovery({
    pool,
    env: isolatedEnv,
    snapshotLedgerSequence: 0,
    throughSequence: 2,
    preflightAccountErasure: async ({ mapping }) => {
      preflightCount += 1;
      assert.equal(mapping.eventType, 'account_erasure_requested');
      return { ready: true, alreadyApplied: false };
    },
    applyEvent: async () => {
      applyCount += 1;
      return { applied: true, alreadyApplied: false };
    }
  });
  assert.equal(preflightCount, 1, 'account preflight still runs when an executor is injected');
  assert.equal(applyCount, 2);
  assert.equal(result.complete, true);
});

test('default account preflight failure blocks the entire batch before earlier event writes', async () => {
  const photoId = '123e4567-e89b-42d3-a456-426614174024';
  const photoRef = createHmac('sha256', key).update(photoId, 'utf8').digest('hex');
  const { pool } = poolFor({
    events: [{
      sequence: '1',
      event_id: '123e4567-e89b-42d3-a456-426614174025',
      event_type: 'private_photo_erasure_requested',
      subject_ref: subjectRef,
      resource_ref: photoRef
    }, {
      sequence: '2',
      event_id: '123e4567-e89b-42d3-a456-426614174026',
      event_type: 'account_erasure_requested',
      subject_ref: subjectRef,
      resource_ref: null
    }],
    photos: [{ id: photoId, user_id: userId }]
  });
  let applyCount = 0;
  const result = await runPrivateMediaPrivacyRecovery({
    pool,
    env: isolatedEnv,
    snapshotLedgerSequence: 0,
    throughSequence: 2,
    preflightAccountErasure: async () => {
      throw new Error('privacy_recovery_account_erasure_l3_media_unresolved');
    },
    applyEvent: undefined
  });
  assert.equal(result.complete, false);
  assert.equal(result.blockedSequence, 2);
  assert.equal(result.blockedEventType, 'account_erasure_requested');
  assert.equal(result.processedCount, 0);
  assert.equal(applyCount, 0);
});

test('coordinator rejects events for a subject after terminal account erasure', async () => {
  const photoId = '123e4567-e89b-42d3-a456-426614174027';
  const photoRef = createHmac('sha256', key).update(photoId, 'utf8').digest('hex');
  const { pool } = poolFor({
    events: [{
      sequence: '1',
      event_id: '123e4567-e89b-42d3-a456-426614174028',
      event_type: 'account_erasure_requested',
      subject_ref: subjectRef,
      resource_ref: null
    }, {
      sequence: '2',
      event_id: '123e4567-e89b-42d3-a456-426614174029',
      event_type: 'private_photo_erasure_requested',
      subject_ref: subjectRef,
      resource_ref: photoRef
    }],
    photos: [{ id: photoId, user_id: userId }]
  });
  let appliedCount = 0;
  const result = await runPrivateMediaPrivacyRecovery({
    pool,
    env: isolatedEnv,
    snapshotLedgerSequence: 0,
    throughSequence: 2,
    applyEvent: async () => {
      appliedCount += 1;
      return { applied: true, alreadyApplied: false };
    },
    preflightAccountErasure: async () => ({ ready: true }),
    preflightAdConsent: async () => ({ ready: true }),
    preflightGiftConsent: async () => ({ ready: true })
  });
  assert.equal(result.complete, false);
  assert.equal(result.blockedSequence, 2);
  assert.equal(result.blockedEventType, 'private_photo_erasure_requested');
  assert.equal(result.processedCount, 0);
  assert.equal(appliedCount, 0);
});
