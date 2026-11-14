import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

test('purge-count migration temporarily drops only the immutability trigger around its backfill and restores it', async () => {
  const sql = await readFile(new URL('./migrations/238_privacy_recovery_purge_count.sql', import.meta.url), 'utf8');
  const drop = sql.indexOf('DROP TRIGGER IF EXISTS privacy_recovery_effects_no_update');
  const backfill = sql.indexOf('UPDATE privacy_recovery_replay_effects AS effect');
  const restore = sql.indexOf('CREATE TRIGGER privacy_recovery_effects_no_update');
  assert.ok(drop >= 0 && backfill > drop && restore > backfill);
  assert.match(sql.slice(restore), /BEFORE UPDATE OR DELETE ON privacy_recovery_replay_effects/);
  assert.match(sql, /ADD COLUMN purge_count INTEGER NOT NULL DEFAULT 0/);
});

test('privacy recovery replay effects remain immutable after purge-count migration', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const eventId = randomUUID();
  const subjectId = randomUUID();
  const resourceId = randomUUID();
  const sequence = (BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))).toString();
  try {
    const schema = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'privacy_recovery_replay_effects'`
    );
    assert.ok(schema.rows.some(row => row.column_name === 'purge_count'));

    await client.query('BEGIN');
    try {
      await client.query(
        `INSERT INTO privacy_recovery_events
          (ledger_sequence, event_id, schema_version, event_type, subject_ref, resource_ref, occurred_at, received_at)
         VALUES ($1, $2, 1, 'private_photo_erasure_requested', $3, $4, now(), now())`,
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
      const effect = await client.query(
        'SELECT purge_count FROM privacy_recovery_replay_effects WHERE ledger_sequence = $1',
        [sequence]
      );
      assert.equal(effect.rows[0].purge_count, 0);
      await assert.rejects(
        client.query('UPDATE privacy_recovery_replay_effects SET purge_count = 1 WHERE ledger_sequence = $1', [sequence]),
        error => error.code === '55000'
      );
      await assert.rejects(
        client.query('DELETE FROM privacy_recovery_replay_effects WHERE ledger_sequence = $1', [sequence]),
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
