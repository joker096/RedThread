import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

test('account-erasure replay evidence schema accepts only a subject-scoped immutable receipt/effect pair', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const eventId = randomUUID();
  const userId = randomUUID();
  const sequence = Number((await client.query(
    'SELECT COALESCE(MAX(ledger_sequence), 0) + 1 AS next_sequence FROM privacy_recovery_events'
  )).rows[0].next_sequence);
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO privacy_recovery_events
         (ledger_sequence, event_id, schema_version, event_type, subject_ref, occurred_at, received_at)
       VALUES ($1, $2, 1, 'account_erasure_requested', $3, statement_timestamp(), statement_timestamp())`,
      [sequence, eventId, 'a'.repeat(64)]
    );
    await client.query(
      `INSERT INTO privacy_recovery_replay_receipts
         (ledger_sequence, event_id, event_digest, event_type, outcome_code)
       VALUES ($1, $2, $3, 'account_erasure_requested', 'account_erasure_replayed')`,
      [sequence, eventId, 'b'.repeat(64)]
    );
    await client.query(
      `INSERT INTO privacy_recovery_replay_effects
         (ledger_sequence, event_id, event_type, subject_user_id, resource_id, purge_count)
       VALUES ($1, $2, 'account_erasure_requested', $3, NULL, 0)`,
      [sequence, eventId, userId]
    );

    await assert.rejects(
      client.query(
        'UPDATE privacy_recovery_replay_receipts SET outcome_code = $2 WHERE ledger_sequence = $1',
        [sequence, 'account_erasure_replayed']
      ),
      error => error.code === '55000',
      'replay receipts must remain append-only'
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
