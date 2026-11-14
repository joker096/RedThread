import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

test('privacy recovery verification evidence is immutable and receipt-bound', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const eventId = randomUUID();
  const sequence = (BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))).toString();
  const subjectId = randomUUID();
  const resourceId = randomUUID();
  const storageDigest = createHash('sha256').update('/private/test/opaque.enc').digest('hex');

  try {
    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name IN ('privacy_recovery_replay_effects', 'privacy_recovery_replay_purge_obligations')`
    );
    assert.deepEqual(new Set(tables.rows.map(row => row.table_name)), new Set([
      'privacy_recovery_replay_effects', 'privacy_recovery_replay_purge_obligations'
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
        `INSERT INTO privacy_recovery_replay_effects
           (ledger_sequence, event_id, event_type, subject_user_id, resource_id)
         VALUES ($1, $2, 'private_photo_erasure_requested', $3, $4)`,
        [sequence, eventId, subjectId, resourceId]
      );
      await client.query(
        `INSERT INTO privacy_recovery_replay_purge_obligations
           (ledger_sequence, event_id, queue_name, storage_path_sha256)
         VALUES ($1, $2, 'private_photo', $3)`,
        [sequence, eventId, storageDigest]
      );

      const evidence = await client.query(
        `SELECT x.subject_user_id, x.resource_id, o.storage_path_sha256
           FROM privacy_recovery_replay_effects x
           JOIN privacy_recovery_replay_purge_obligations o USING (ledger_sequence, event_id)
          WHERE x.ledger_sequence = $1`,
        [sequence]
      );
      assert.equal(evidence.rowCount, 1);
      assert.equal(evidence.rows[0].subject_user_id, subjectId);
      assert.equal(evidence.rows[0].resource_id, resourceId);
      assert.equal(evidence.rows[0].storage_path_sha256, storageDigest);

      await client.query('SAVEPOINT immutable_effect_update');
      await assert.rejects(
        client.query('UPDATE privacy_recovery_replay_effects SET resource_id = resource_id WHERE ledger_sequence = $1', [sequence]),
        error => error.code === '55000'
      );
      await client.query('ROLLBACK TO SAVEPOINT immutable_effect_update');
      await client.query('RELEASE SAVEPOINT immutable_effect_update');

      await client.query('SAVEPOINT immutable_purge_obligation_delete');
      await assert.rejects(
        client.query('DELETE FROM privacy_recovery_replay_purge_obligations WHERE ledger_sequence = $1', [sequence]),
        error => error.code === '55000'
      );
      await client.query('ROLLBACK TO SAVEPOINT immutable_purge_obligation_delete');
      await client.query('RELEASE SAVEPOINT immutable_purge_obligation_delete');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
    }

    await client.query('BEGIN');
    try {
      await assert.rejects(
        client.query(
          `INSERT INTO privacy_recovery_replay_effects
             (ledger_sequence, event_id, event_type, subject_user_id, resource_id)
           VALUES ($1, $2, 'private_photo_erasure_requested', $3, $4)`,
          [sequence, eventId, subjectId, resourceId]
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


test('privacy recovery replay transaction rolls back receipt, effects and purge obligations together', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const eventId = randomUUID();
  const sequence = (BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))).toString();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO privacy_recovery_events
         (ledger_sequence, event_id, schema_version, event_type, subject_ref, resource_ref, occurred_at, received_at)
       VALUES ($1, $2, 1, 'private_photo_erasure_requested', $3, $4, statement_timestamp(), statement_timestamp())`,
      [sequence, eventId, 'd'.repeat(64), 'e'.repeat(64)]
    );
    await client.query(
      `INSERT INTO privacy_recovery_replay_receipts
         (ledger_sequence, event_id, event_digest, event_type, outcome_code)
       VALUES ($1, $2, $3, 'private_photo_erasure_requested', 'photo_erasure_queued')`,
      [sequence, eventId, 'f'.repeat(64)]
    );
    await client.query(
      `INSERT INTO privacy_recovery_replay_effects
         (ledger_sequence, event_id, event_type, subject_user_id, resource_id)
       VALUES ($1, $2, 'private_photo_erasure_requested', $3, $4)`,
      [sequence, eventId, randomUUID(), randomUUID()]
    );
    await client.query(
      `INSERT INTO privacy_recovery_replay_purge_obligations
         (ledger_sequence, event_id, queue_name, storage_path_sha256)
       VALUES ($1, $2, 'private_photo', $3)`,
      [sequence, eventId, createHash('sha256').update(randomUUID()).digest('hex')]
    );
    await client.query('ROLLBACK');

    const counts = await client.query(
      `SELECT
         (SELECT count(*) FROM privacy_recovery_events WHERE ledger_sequence = $1) AS events,
         (SELECT count(*) FROM privacy_recovery_replay_receipts WHERE ledger_sequence = $1) AS receipts,
         (SELECT count(*) FROM privacy_recovery_replay_effects WHERE ledger_sequence = $1) AS effects,
         (SELECT count(*) FROM privacy_recovery_replay_purge_obligations WHERE ledger_sequence = $1) AS obligations`,
      [sequence]
    );
    assert.deepEqual(counts.rows[0], {
      events: '0', receipts: '0', effects: '0', obligations: '0'
    });
  } finally {
    client.release();
    await pool.end();
  }
});

test('concurrent privacy recovery retries serialize on the subject lock and observe one receipt', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const first = await pool.connect();
  const second = await pool.connect();
  const eventId = randomUUID();
  const subjectId = randomUUID();
  const resourceId = randomUUID();
  const sequence = (BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))).toString();
  const subjectLock = "SELECT pg_advisory_xact_lock(hashtext('gift-safety-user:' || $1::uuid::text))";
  try {
    await first.query('BEGIN');
    await first.query(subjectLock, [subjectId]);
    await first.query(
      `INSERT INTO privacy_recovery_events
         (ledger_sequence, event_id, schema_version, event_type, subject_ref, resource_ref, occurred_at, received_at)
       VALUES ($1, $2, 1, 'private_photo_erasure_requested', $3, $4, statement_timestamp(), statement_timestamp())`,
      [sequence, eventId, '1'.repeat(64), '2'.repeat(64)]
    );

    await second.query('BEGIN');
    const waitingRetry = second.query(subjectLock, [subjectId]);
    await new Promise(resolve => setTimeout(resolve, 30));

    await first.query(
      `INSERT INTO privacy_recovery_replay_receipts
         (ledger_sequence, event_id, event_digest, event_type, outcome_code)
       VALUES ($1, $2, $3, 'private_photo_erasure_requested', 'photo_erasure_queued')`,
      [sequence, eventId, '3'.repeat(64)]
    );
    await first.query(
      `INSERT INTO privacy_recovery_replay_effects
         (ledger_sequence, event_id, event_type, subject_user_id, resource_id)
       VALUES ($1, $2, 'private_photo_erasure_requested', $3, $4)`,
      [sequence, eventId, subjectId, resourceId]
    );
    await first.query(
      `INSERT INTO privacy_recovery_replay_purge_obligations
         (ledger_sequence, event_id, queue_name, storage_path_sha256)
       VALUES ($1, $2, 'private_photo', $3)`,
      [sequence, eventId, createHash('sha256').update('/isolated/recovery/concurrent.enc').digest('hex')]
    );
    await first.query('COMMIT');

    await waitingRetry;
    const receipt = await second.query(
      'SELECT outcome_code FROM privacy_recovery_replay_receipts WHERE ledger_sequence = $1 AND event_id = $2',
      [sequence, eventId]
    );
    assert.equal(receipt.rowCount, 1);
    assert.equal(receipt.rows[0].outcome_code, 'photo_erasure_queued');
    await second.query('COMMIT');

    const evidence = await first.query(
      `SELECT
         (SELECT count(*) FROM privacy_recovery_replay_receipts WHERE ledger_sequence = $1) AS receipts,
         (SELECT count(*) FROM privacy_recovery_replay_effects WHERE ledger_sequence = $1) AS effects,
         (SELECT count(*) FROM privacy_recovery_replay_purge_obligations WHERE ledger_sequence = $1) AS obligations`,
      [sequence]
    );
    assert.deepEqual(evidence.rows[0], { receipts: '1', effects: '1', obligations: '1' });
  } catch (error) {
    await first.query('ROLLBACK').catch(() => {});
    await second.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    first.release();
    second.release();
    await pool.end();
  }
});
