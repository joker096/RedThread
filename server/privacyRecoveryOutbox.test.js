import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { enqueuePrivacyRecoveryEvent, processPrivacyRecoveryOutboxBatch } from './privacyRecoveryOutbox.js';

const env = {
  NODE_ENV: 'production',
  PRIVACY_RECOVERY_LEDGER_REQUIRED: 'true',
  PRIVACY_RECOVERY_LEDGER_URL: 'https://ledger.example',
  PRIVACY_RECOVERY_LEDGER_HMAC_SECRET: 'auth-secret-at-least-32-characters-long',
  PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY: 'pseudonym-secret-at-least-32-characters'
};

test('outbox insert uses a stable UUID and stores only pseudonymized references', async () => {
  let inserted;
  const client = { query: async (sql, values) => { inserted = { sql, values }; return { rowCount: 1 }; } };
  const eventId = randomUUID();
  const result = await enqueuePrivacyRecoveryEvent(client, {
    eventType: 'private_photo_erasure_requested', userId: 'private-user-id',
    resourceId: 'private-photo-id', eventId
  }, { env });
  const payload = JSON.parse(inserted.values[1]);
  assert.equal(result.queued, true);
  assert.equal(payload.event_id, eventId);
  assert.notEqual(payload.subject_ref, 'private-user-id');
  assert.notEqual(payload.resource_ref, 'private-photo-id');
  assert.match(inserted.sql, /ON CONFLICT \(event_id\) DO NOTHING/);
});

test('production refuses to enqueue when ledger configuration is missing', async () => {
  await assert.rejects(
    enqueuePrivacyRecoveryEvent({ query: async () => { throw new Error('must not insert'); } },
      { eventType: 'account_erasure_requested', userId: 'u1' },
      { env: { NODE_ENV: 'production' } }),
    /not_configured/
  );
});

test('worker delivers the persisted payload and records the acknowledged sequence', async () => {
  const eventId = randomUUID();
  const leaseToken = randomUUID();
  const payload = {
    event_id: eventId, schema_version: 1, event_type: 'account_erasure_requested',
    subject_ref: 'a'.repeat(64), occurred_at: '2026-11-16T00:00:00.000Z'
  };
  const calls = [];
  const pool = {
    connect: async () => ({
      query: async (sql, values = []) => {
        calls.push({ sql, values });
        if (sql.includes('RETURNING outbox.event_id')) return { rows: [{ event_id: eventId, event_payload: payload, attempts: 1, lease_token: leaseToken }] };
        return { rowCount: 1, rows: [] };
      },
      release() {}
    })
  };
  const result = await processPrivacyRecoveryOutboxBatch({
    pool, env, fetchImpl: async () => new Response(JSON.stringify({ accepted: true, sequence: 42 }), { status: 201 })
  });
  assert.equal(result.claimed, 1);
  assert.deepEqual(result.results[0], { eventId, acknowledged: true, sequence: 42 });
  assert.equal(calls.some(call => call.sql.includes("status = 'acknowledged'") && call.values[1] === 42 && call.values[2] === leaseToken), true);
});

test('worker retains failed deliveries for retry with the same event identity', async () => {
  const eventId = randomUUID();
  const leaseToken = randomUUID();
  const payload = {
    event_id: eventId, schema_version: 1, event_type: 'account_erasure_requested',
    subject_ref: 'b'.repeat(64), occurred_at: '2026-11-16T00:00:00.000Z'
  };
  let retry;
  const pool = {
    connect: async () => ({
      query: async (sql, values = []) => {
        if (sql.includes('RETURNING outbox.event_id')) return { rows: [{ event_id: eventId, event_payload: payload, attempts: 1, lease_token: leaseToken }] };
        retry = { sql, values };
        return { rowCount: 1, rows: [] };
      },
      release() {}
    })
  };
  const result = await processPrivacyRecoveryOutboxBatch({
    pool, env, fetchImpl: async () => { throw new Error('offline'); }
  });
  assert.equal(result.results[0].acknowledged, false);
  assert.match(retry.sql, /status = 'pending'/);
  assert.equal(retry.values[0], eventId);
  assert.equal(retry.values[3], leaseToken);
});
