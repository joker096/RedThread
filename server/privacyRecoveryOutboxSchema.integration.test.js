import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { enqueuePrivacyRecoveryEvent } from './privacyRecoveryOutbox.js';

const { Pool } = pg;
const env = {
  NODE_ENV: 'production',
  PRIVACY_RECOVERY_LEDGER_REQUIRED: 'true',
  PRIVACY_RECOVERY_LEDGER_URL: 'https://ledger.example',
  PRIVACY_RECOVERY_LEDGER_HMAC_SECRET: 'auth-secret-at-least-32-characters-long',
  PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY: 'pseudonym-secret-at-least-32-characters'
};

test('domain rollback atomically removes its privacy recovery outbox event', {
  skip: !process.env.DATABASE_URL ? 'DATABASE_URL is not configured' : false,
  timeout: 15_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const eventId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const queued = await enqueuePrivacyRecoveryEvent(client, {
      eventType: 'account_erasure_requested',
      userId: randomUUID(),
      eventId
    }, { env });
    assert.equal(queued.eventId, eventId);
    const inside = await client.query(
      'SELECT status, event_payload->>\'event_id\' AS payload_event_id FROM privacy_recovery_ledger_outbox WHERE event_id = $1',
      [eventId]
    );
    assert.equal(inside.rowCount, 1);
    assert.equal(inside.rows[0].status, 'pending');
    assert.equal(inside.rows[0].payload_event_id, eventId);

    const outsideBeforeRollback = await pool.query(
      'SELECT 1 FROM privacy_recovery_ledger_outbox WHERE event_id = $1',
      [eventId]
    );
    assert.equal(outsideBeforeRollback.rowCount, 0,
      'uncommitted domain event must not be visible to the worker');

    await client.query('ROLLBACK');
    const afterRollback = await pool.query(
      'SELECT 1 FROM privacy_recovery_ledger_outbox WHERE event_id = $1',
      [eventId]
    );
    assert.equal(afterRollback.rowCount, 0,
      'rollback must remove the outbox row together with the domain mutation');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});
