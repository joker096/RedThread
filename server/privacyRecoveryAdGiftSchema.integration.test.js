import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

test('privacy replay schema accepts ad revocation and gift consent withdrawal with correct resource scopes', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const base = BigInt(Date.now()) * 1000n;
  const userId = randomUUID();
  const orderId = randomUUID();
  const adEventId = randomUUID();
  const giftEventId = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO privacy_recovery_events
         (ledger_sequence, event_id, schema_version, event_type, subject_ref, resource_ref, occurred_at, received_at)
       VALUES
         ($1, $2, 1, 'ad_consent_revoked', $3, NULL, statement_timestamp(), statement_timestamp()),
         ($4, $5, 1, 'gift_order_consent_withdrawn', $6, $7, statement_timestamp(), statement_timestamp())`,
      [base.toString(), adEventId, 'a'.repeat(64),
       (base + 1n).toString(), giftEventId, 'b'.repeat(64), 'c'.repeat(64)]
    );
    await client.query(
      `INSERT INTO privacy_recovery_replay_receipts
         (ledger_sequence, event_id, event_digest, event_type, outcome_code)
       VALUES
         ($1, $2, $3, 'ad_consent_revoked', 'ad_consent_revoked_fail_closed'),
         ($4, $5, $6, 'gift_order_consent_withdrawn', 'gift_order_consent_withdrawn')`,
      [base.toString(), adEventId, 'd'.repeat(64),
       (base + 1n).toString(), giftEventId, 'e'.repeat(64)]
    );
    await client.query(
      `INSERT INTO privacy_recovery_replay_effects
         (ledger_sequence, event_id, event_type, subject_user_id, resource_id, purge_count)
       VALUES
         ($1, $2, 'ad_consent_revoked', $3, NULL, 0),
         ($4, $5, 'gift_order_consent_withdrawn', $3, $6, 0)`,
      [base.toString(), adEventId, userId, (base + 1n).toString(), giftEventId, orderId]
    );
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
});
