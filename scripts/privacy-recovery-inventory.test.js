import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { runPrivacyRecoveryInventory } from './privacy-recovery-inventory.js';

const key = 'privacy-recovery-inventory-test-key-32-bytes';
const userId = randomUUID();
const photoId = randomUUID();
const ref = id => createHmac('sha256', key).update(id, 'utf8').digest('hex');
const env = {
  NODE_ENV: 'test',
  PRIVACY_RECOVERY_RESTORE_ISOLATED: 'true',
  DATABASE_URL: 'postgres://localhost/isolated_restore',
  PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY: key
};

function fakePool({ events = [], users = [], voiceIntros = [], photos = [], giftOrders = [] } = {}) {
  const calls = [];
  const data = { events, users, voiceIntros, photos, giftOrders };
  return {
    calls,
    async connect() {
      return {
        async query(sql) {
          calls.push(sql);
          if (sql.startsWith('SELECT ledger_sequence')) return { rows: data.events, rowCount: data.events.length };
          if (sql === 'SELECT id FROM users') return { rows: data.users, rowCount: data.users.length };
          if (sql === 'SELECT id FROM profile_voice_intros') return { rows: data.voiceIntros, rowCount: data.voiceIntros.length };
          if (sql === 'SELECT id FROM photo_assets') return { rows: data.photos, rowCount: data.photos.length };
          if (sql === 'SELECT id FROM gift_delivery_orders') return { rows: data.giftOrders, rowCount: data.giftOrders.length };
          return { rows: [], rowCount: 0 };
        },
        release() { calls.push('RELEASE'); }
      };
    }
  };
}

test('read-only inventory maps staged event and emits counts without identifiers', async () => {
  const pool = fakePool({
    events: [{
      sequence: 4, event_id: randomUUID(), event_type: 'private_photo_erasure_requested',
      subject_ref: ref(userId), resource_ref: ref(photoId)
    }],
    users: [{ id: userId }], photos: [{ id: photoId }]
  });
  const report = await runPrivacyRecoveryInventory({ pool, env });
  assert.equal(report.readyForDomainReplay, true);
  assert.equal(report.matchedCount, 1);
  assert.equal(report.firstSequence, 4);
  assert.equal(report.lastSequence, 4);
  assert.equal(JSON.stringify(report).includes(userId), false);
  assert.equal(JSON.stringify(report).includes(photoId), false);
  assert.ok(pool.calls[0].includes('READ ONLY'));
  assert.equal(pool.calls.at(-2), 'COMMIT');
  assert.ok(!pool.calls.some(call => /^(INSERT|UPDATE|DELETE|TRUNCATE)/i.test(call)));
});

test('unresolved mappings fail readiness and report only sequence numbers', async () => {
  const pool = fakePool({
    events: [{
      sequence: 1, event_id: randomUUID(), event_type: 'account_erasure_requested',
      subject_ref: ref(userId), resource_ref: null
    }]
  });
  const report = await runPrivacyRecoveryInventory({ pool, env });
  assert.equal(report.readyForDomainReplay, false);
  assert.equal(report.unresolvedSequences[0], 1);
  assert.equal(report.byStatus.subject_unmatched, 1);
});

test('refuses production or non-isolated execution before opening a connection', async () => {
  let connected = false;
  const pool = { async connect() { connected = true; } };
  await assert.rejects(runPrivacyRecoveryInventory({
    pool, env: { ...env, NODE_ENV: 'production' }
  }), /requires_isolated_restore/);
  await assert.rejects(runPrivacyRecoveryInventory({
    pool, env: { ...env, PRIVACY_RECOVERY_RESTORE_ISOLATED: 'false' }
  }), /requires_isolated_restore/);
  assert.equal(connected, false);
});

test('rejects gaps in the staged ledger sequence and rolls back', async () => {
  const pool = fakePool({ events: [
    { sequence: 1, event_id: randomUUID(), event_type: 'account_erasure_requested', subject_ref: ref(userId), resource_ref: null },
    { sequence: 3, event_id: randomUUID(), event_type: 'account_erasure_requested', subject_ref: ref(userId), resource_ref: null }
  ] });
  await assert.rejects(runPrivacyRecoveryInventory({ pool, env }), /staged_sequence_gap/);
  assert.ok(pool.calls.includes('ROLLBACK'));
});
