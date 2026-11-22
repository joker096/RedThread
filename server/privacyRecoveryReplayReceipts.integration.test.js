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
  const occurredAt = new Date('2026-11-14T00:00:00.000Z');
  const receivedAt = new Date('2026-11-14T00:00:01.000Z');
  const digest = createHash('sha256').update(JSON.stringify([
    String(sequence), eventId, '1', 'private_photo_erasure_requested',
    subjectRef, resourceRef, occurredAt.toISOString(), receivedAt.toISOString()
  ])).digest('hex');

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
        [sequence.toString(), eventId, subjectRef, resourceRef, occurredAt, receivedAt]
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
        [sequence.toString(), eventId, subjectRef, resourceRef, occurredAt, receivedAt]
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
        [sequence.toString(), eventId, subjectRef, resourceRef, occurredAt, receivedAt]
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


test('L3 consent replay receipt and purge proof are accepted by the extended schema', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const eventId = randomUUID();
  const sequence = (BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))).toString();
  const subjectRef = 'd'.repeat(64);
  const digest = createHash('sha256').update(JSON.stringify([
    sequence, eventId, '1', 'identity_l3_consent_withdrawn',
    subjectRef, null, '2026-11-16T00:00:00.000Z', '2026-11-16T00:00:01.000Z'
  ])).digest('hex');
  const pathDigest = createHash('sha256').update('private-l3-object-key').digest('hex');
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO privacy_recovery_events
         (ledger_sequence, event_id, schema_version, event_type, subject_ref, resource_ref, occurred_at, received_at)
       VALUES ($1, $2, 1, 'identity_l3_consent_withdrawn', $3, NULL, $4, $5)`,
      [sequence, eventId, subjectRef, new Date('2026-11-16T00:00:00.000Z'), new Date('2026-11-16T00:00:01.000Z')]
    );
    await client.query(
      `INSERT INTO privacy_recovery_replay_receipts
         (ledger_sequence, event_id, event_digest, event_type, outcome_code)
       VALUES ($1, $2, $3, 'identity_l3_consent_withdrawn', 'identity_l3_consent_withdrawn')`,
      [sequence, eventId, digest]
    );
    await client.query(
      `INSERT INTO privacy_recovery_replay_effects
         (ledger_sequence, event_id, event_type, subject_user_id, resource_id, purge_count)
       VALUES ($1, $2, 'identity_l3_consent_withdrawn', $3, NULL, 1)`,
      [sequence, eventId, '123e4567-e89b-42d3-a456-426614174000']
    );
    await client.query(
      `INSERT INTO privacy_recovery_replay_purge_obligations
         (ledger_sequence, event_id, queue_name, storage_path_sha256)
       VALUES ($1, $2, 'identity_l3_media', $3)`,
      [sequence, eventId, pathDigest]
    );
    await client.query(
      `INSERT INTO privacy_recovery_replay_purge_completions
         (ledger_sequence, queue_name, storage_path_sha256)
       VALUES ($1, 'identity_l3_media', $2)`,
      [sequence, pathDigest]
    );
    const proof = await client.query(
      `SELECT o.queue_name, c.completed_at
         FROM privacy_recovery_replay_purge_obligations o
         JOIN privacy_recovery_replay_purge_completions c
           USING (ledger_sequence, queue_name, storage_path_sha256)
        WHERE o.ledger_sequence = $1`,
      [sequence]
    );
    assert.equal(proof.rowCount, 1);
    assert.equal(proof.rows[0].queue_name, 'identity_l3_media');
    assert.ok(proof.rows[0].completed_at);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});

test('gift address draft replay receipt and effect are accepted by the extended schema', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const eventId = randomUUID();
  const sequence = (BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))).toString();
  const subjectRef = 'e'.repeat(64);
  const resourceRef = 'f'.repeat(64);
  const subjectId = randomUUID();
  const orderId = randomUUID();
  const digest = createHash('sha256').update(JSON.stringify([
    sequence, eventId, '1', 'gift_address_draft_consent_withdrawn',
    subjectRef, resourceRef, '2026-11-22T00:00:00.000Z', '2026-11-22T00:00:01.000Z'
  ])).digest('hex');
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO privacy_recovery_events
         (ledger_sequence, event_id, schema_version, event_type, subject_ref, resource_ref, occurred_at, received_at)
       VALUES ($1, $2, 1, 'gift_address_draft_consent_withdrawn', $3, $4, $5, $6)`,
      [sequence, eventId, subjectRef, resourceRef,
        new Date('2026-11-22T00:00:00.000Z'), new Date('2026-11-22T00:00:01.000Z')]
    );
    await client.query(
      `INSERT INTO privacy_recovery_replay_receipts
         (ledger_sequence, event_id, event_digest, event_type, outcome_code)
       VALUES ($1, $2, $3, 'gift_address_draft_consent_withdrawn',
               'gift_address_draft_consent_withdrawn')`,
      [sequence, eventId, digest]
    );
    await client.query(
      `INSERT INTO privacy_recovery_replay_effects
         (ledger_sequence, event_id, event_type, subject_user_id, resource_id, purge_count)
       VALUES ($1, $2, 'gift_address_draft_consent_withdrawn', $3, $4, 0)`,
      [sequence, eventId, subjectId, orderId]
    );
    const evidence = await client.query(
      `SELECT r.event_type, r.outcome_code, e.subject_user_id, e.resource_id, e.purge_count
         FROM privacy_recovery_replay_receipts r
         JOIN privacy_recovery_replay_effects e USING (ledger_sequence, event_id)
        WHERE r.ledger_sequence = $1`,
      [sequence]
    );
    assert.equal(evidence.rowCount, 1);
    assert.equal(evidence.rows[0].event_type, 'gift_address_draft_consent_withdrawn');
    assert.equal(evidence.rows[0].outcome_code, 'gift_address_draft_consent_withdrawn');
    assert.equal(evidence.rows[0].subject_user_id, subjectId);
    assert.equal(evidence.rows[0].resource_id, orderId);
    assert.equal(evidence.rows[0].purge_count, 0);

    await client.query('SAVEPOINT reject_gift_draft_wrong_outcome');
    await assert.rejects(
      client.query(
        `INSERT INTO privacy_recovery_replay_receipts
           (ledger_sequence, event_id, event_digest, event_type, outcome_code)
         VALUES ($1, $2, $3, 'gift_address_draft_consent_withdrawn', 'photo_erasure_queued')`,
        [(BigInt(sequence) + 1n).toString(), randomUUID(), digest]
      ),
      error => error.code === '23514'
    );
    await client.query('ROLLBACK TO SAVEPOINT reject_gift_draft_wrong_outcome');

    await client.query('SAVEPOINT reject_gift_draft_missing_resource');
    await assert.rejects(
      client.query(
        `INSERT INTO privacy_recovery_replay_effects
           (ledger_sequence, event_id, event_type, subject_user_id, resource_id, purge_count)
         VALUES ($1, $2, 'gift_address_draft_consent_withdrawn', $3, NULL, 0)`,
        [(BigInt(sequence) + 2n).toString(), randomUUID(), subjectId]
      ),
      error => error.code === '23514'
    );
    await client.query('ROLLBACK TO SAVEPOINT reject_gift_draft_missing_resource');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});

