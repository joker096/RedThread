import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { resumePendingPrivacyRecoveryLedgerAcks } from './privacyRecoveryAckResumer.js';
import { startTestPrivacyRecoveryLedger } from './testPrivacyRecoveryLedger.js';

const { Pool } = pg;

test('PostgreSQL ACK resumer claims due operations, delivers outside transaction and persists ACK lease release', {
  skip: !process.env.DATABASE_URL,
  timeout: 30_000
}, async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const ledger = await startTestPrivacyRecoveryLedger();
  const operationId = randomUUID();
  const payload = {
    event_id: operationId,
    schema_version: 1,
    event_type: 'private_photo_erasure_requested',
    subject_ref: 'a'.repeat(64),
    resource_ref: 'b'.repeat(64),
    occurred_at: '2026-11-18T08:00:00.000Z'
  };
  const env = {
    NODE_ENV: 'test',
    PRIVACY_RECOVERY_LEDGER_REQUIRED: 'true',
    PRIVACY_RECOVERY_LEDGER_URL: ledger.url,
    PRIVACY_RECOVERY_LEDGER_HMAC_SECRET: 'test-ledger-hmac-secret-'.padEnd(40, 'x')
  };

  try {
    await db.query(
      `INSERT INTO privacy_recovery_operations (operation_id, event_id, event_payload)
       VALUES ($1, $1, $2::jsonb)`,
      [operationId, JSON.stringify(payload)]
    );

    const result = await resumePendingPrivacyRecoveryLedgerAcks({
      pool: db, env, now: () => Date.parse('2026-11-18T08:00:00.000Z')
    });
    assert.deepEqual(result, { claimed: 1, acknowledged: 1, deferred: 0, leaseLost: 0 });

    const stored = await db.query(
      `SELECT status, ledger_sequence, ack_attempts, ack_lease_token,
              ack_lease_expires_at, ack_last_error_code
         FROM privacy_recovery_operations WHERE operation_id = $1`,
      [operationId]
    );
    assert.deepEqual(stored.rows[0], {
      status: 'acknowledged',
      ledger_sequence: '1',
      ack_attempts: 1,
      ack_lease_token: null,
      ack_lease_expires_at: null,
      ack_last_error_code: null
    });
    assert.equal(ledger.events.length, 1);

    const second = await resumePendingPrivacyRecoveryLedgerAcks({ pool: db, env });
    assert.deepEqual(second, { claimed: 0, acknowledged: 0, deferred: 0, leaseLost: 0 });
    assert.equal(ledger.events.length, 1, 'acknowledged operations must not be redelivered by the ACK repair worker');
  } finally {
    await db.query('DELETE FROM privacy_recovery_operations WHERE operation_id = $1', [operationId]).catch(() => {});
    await db.end();
    await ledger.close().catch(() => {});
  }
});
