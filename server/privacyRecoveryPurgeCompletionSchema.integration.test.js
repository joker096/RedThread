import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

test('privacy recovery purge completion schema is append-only and bound to an immutable obligation', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const eventId = randomUUID();
  const sequence = (BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))).toString();
  const pathDigest = createHash('sha256').update('/isolated/recovery/purge-fixture.jpg').digest('hex');
  try {
    const columns = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'privacy_recovery_replay_purge_completions'`
    );
    assert.deepEqual(new Set(columns.rows.map(row => row.column_name)), new Set([
      'ledger_sequence', 'queue_name', 'storage_path_sha256', 'completed_at'
    ]));

    await client.query('BEGIN');
    try {
      await client.query(
        `INSERT INTO privacy_recovery_events
           (ledger_sequence, event_id, schema_version, event_type, subject_ref, resource_ref, occurred_at, received_at)
         VALUES ($1, $2, 1, 'private_photo_erasure_requested', $3, $4, statement_timestamp(), statement_timestamp())`,
        [sequence, eventId, 'a'.repeat(64), 'b'.repeat(64)]
      );
      await client.query(
        `INSERT INTO privacy_recovery_replay_receipts
           (ledger_sequence, event_id, event_digest, event_type, outcome_code)
         VALUES ($1, $2, $3, 'private_photo_erasure_requested', 'photo_erasure_queued')`,
        [sequence, eventId, 'c'.repeat(64)]
      );
      await client.query(
        `INSERT INTO privacy_recovery_replay_purge_obligations
           (ledger_sequence, event_id, queue_name, storage_path_sha256)
         VALUES ($1, $2, 'private_photo', $3)`,
        [sequence, eventId, pathDigest]
      );
      await client.query(
        `INSERT INTO privacy_recovery_replay_purge_completions
           (ledger_sequence, queue_name, storage_path_sha256)
         VALUES ($1, 'private_photo', $2)`,
        [sequence, pathDigest]
      );
      const completion = await client.query(
        `SELECT c.completed_at, c.storage_path_sha256
           FROM privacy_recovery_replay_purge_completions c
           JOIN privacy_recovery_replay_purge_obligations o
             USING (ledger_sequence, queue_name, storage_path_sha256)
          WHERE c.ledger_sequence = $1`,
        [sequence]
      );
      assert.equal(completion.rowCount, 1);
      assert.ok(completion.rows[0].completed_at);
      assert.equal(completion.rows[0].storage_path_sha256, pathDigest);

      await client.query('SAVEPOINT reject_completion_update');
      await assert.rejects(
        client.query(
          'UPDATE privacy_recovery_replay_purge_completions SET completed_at = completed_at WHERE ledger_sequence = $1',
          [sequence]
        ),
        error => error.code === '55000'
      );
      await client.query('ROLLBACK TO SAVEPOINT reject_completion_update');

      await client.query('SAVEPOINT reject_completion_delete');
      await assert.rejects(
        client.query(
          'DELETE FROM privacy_recovery_replay_purge_completions WHERE ledger_sequence = $1',
          [sequence]
        ),
        error => error.code === '55000'
      );
      await client.query('ROLLBACK TO SAVEPOINT reject_completion_delete');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
    }

    await client.query('BEGIN');
    try {
      await assert.rejects(
        client.query(
          `INSERT INTO privacy_recovery_replay_purge_completions
             (ledger_sequence, queue_name, storage_path_sha256)
           VALUES ($1, 'private_photo', $2)`,
          [sequence, pathDigest]
        ),
        error => error.code === '23503'
      );
    } finally {
      await client.query('ROLLBACK').catch(() => {});
    }
  } finally {
    client.release();
    await pool.end();
  }
});
