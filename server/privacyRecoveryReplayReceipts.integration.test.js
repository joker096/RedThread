import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

test('privacy recovery replay receipts are append-only, unique and bound to staged events', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const eventId = randomUUID();
  const sequence = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
  const subjectRef = 'a'.repeat(64);
  const resourceRef = 'b'.repeat(64);
  const digest = createHash('sha256').update([String(sequence), eventId, '1',
    'private_photo_erasure_requested', subjectRef, resourceRef,
    '2026-11-14T00:00:00.000Z', '2026-11-14T00:00:01.000Z'].join('|')).digest('hex');

  try {
    const table = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'privacy_recovery_replay_receipts'`
    );
    const columns = new Set(table.rows.map(row => row.column_name));
    for (const column of ['ledger_sequence', 'event_id', 'event_digest', 'event_type', 'outcome_code', 'applied_at']) {
      assert.ok(columns.has(column), `missing replay receipt column: ${column}`);
    }

    await client.query('BEGIN');
    try {
      await client.query(
        `INSERT INTO privacy_recovery_events
           (ledger_sequence, event_id, schema_version, event_type, subject_ref, resource_ref, occurred_at, received_at)
         VALUES ($1, $2, 1, 'private_photo_erasure_requested', $3, $4, $5, $6)`,
        [sequence.toString(), eventId, subjectRef, resourceRef, '2026-11-14T00:00:00Z', '2026-11-14T00:00:01Z']
      );
      await client.query(
        `INSERT INTO privacy_recovery_replay_receipts
           (ledger_sequence, event_id, event_digest, event_type, outcome_code)
         VALUES ($1, $2, $3, 'private_photo_erasure_requested', 'photo_erasure_queued')`,
        [sequence.toString(), eventId, digest]
      );
      const receipt = await client.query(
        'SELECT event_digest, event_type, outcome_code FROM privacy_recovery_replay_receipts WHERE ledger_sequence = $1',
        [sequence.toString()]
      );
      assert.equal(receipt.rowCount, 1);
      assert.equal(receipt.rows[0].event_digest, digest);
      assert.equal(receipt.rows[0].outcome_code, 'photo_erasure_queued');

      await client.query('SAVEPOINT duplicate_receipt');
      await assert.rejects(
        client.query(
          `INSERT INTO privacy_recovery_replay_receipts
             (ledger_sequence, event_id, event_digest, event_type, outcome_code)
           VALUES ($1, $2, $3, 'private_photo_erasure_requested', 'photo_erasure_queued')`,
          [sequence.toString(), eventId, digest]
        ),
        error => error.code === '23505'
      );
      await client.query('ROLLBACK TO SAVEPOINT duplicate_receipt');

      await client.query('SAVEPOINT mismatched_outcome');
      await assert.rejects(
        client.query(
          `INSERT INTO privacy_recovery_replay_receipts
             (ledger_sequence, event_id, event_digest, event_type, outcome_code)
           VALUES ($1, $2, $3, 'private_photo_erasure_requested', 'voice_intro_erasure_queued')`,
          [sequence.toString(), randomUUID(), digest]
        ),
        error => error.code === '23514'
      );
      await client.query('ROLLBACK TO SAVEPOINT mismatched_outcome');
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }

    await client.query('BEGIN');
    try {
      await client.query(
        `INSERT INTO privacy_recovery_events
           (ledger_sequence, event_id, schema_version, event_type, subject_ref, resource_ref, occurred_at, received_at)
         VALUES ($1, $2, 1, 'private_photo_erasure_requested', $3, $4, $5, $6)`,
        [sequence.toString(), eventId, subjectRef, resourceRef, '2026-11-14T00:00:00Z', '2026-11-14T00:00:01Z']
      );
      await client.query(
        `INSERT INTO privacy_recovery_replay_receipts
           (ledger_sequence, event_id, event_digest, event_type, outcome_code)
         VALUES ($1, $2, $3, 'private_photo_erasure_requested', 'photo_erasure_queued')`,
        [sequence.toString(), eventId, digest]
      );
      await assert.rejects(
        client.query('UPDATE privacy_recovery_replay_receipts SET outcome_code = outcome_code WHERE event_id = $1', [eventId]),
        error => error.code === '55000'
      );
    } finally {
      await client.query('ROLLBACK').catch(() => {});
    }

    await client.query('BEGIN');
    try {
      await client.query(
        `INSERT INTO privacy_recovery_events
           (ledger_sequence, event_id, schema_version, event_type, subject_ref, resource_ref, occurred_at, received_at)
         VALUES ($1, $2, 1, 'private_photo_erasure_requested', $3, $4, $5, $6)`,
        [sequence.toString(), eventId, subjectRef, resourceRef, '2026-11-14T00:00:00Z', '2026-11-14T00:00:01Z']
      );
      await client.query(
        `INSERT INTO privacy_recovery_replay_receipts
           (ledger_sequence, event_id, event_digest, event_type, outcome_code)
         VALUES ($1, $2, $3, 'private_photo_erasure_requested', 'photo_erasure_queued')`,
        [sequence.toString(), eventId, digest]
      );
      await assert.rejects(
        client.query('DELETE FROM privacy_recovery_replay_receipts WHERE event_id = $1', [eventId]),
        error => error.code === '55000'
      );
    } finally {
      await client.query('ROLLBACK').catch(() => {});
    }
  } finally {
    client.release();
    await pool.end();
  }
});
