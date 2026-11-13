import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Pool } = pg;

test('voice intro migration journal persists guarded, append-only recovery state', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const id = randomUUID();
  const introId = randomUUID();
  let client;
  try {
    client = await pool.connect();
    const table = await client.query(
      "SELECT to_regclass('public.voice_intro_migration_journal') AS journal, to_regclass('public.voice_intro_migration_journal_events') AS events"
    );
    assert.equal(table.rows[0].journal, 'voice_intro_migration_journal');
    assert.equal(table.rows[0].events, 'voice_intro_migration_journal_events');

    const inserted = await client.query(
      `INSERT INTO voice_intro_migration_journal
        (id, idempotency_key, voice_intro_id, source_path, source_sha256, source_format, target_key_id)
       VALUES ($1, $2, $3, '/private/voice/source.enc', $4, 'VOWVOICE1', 'voice-next')
       RETURNING state, version`,
      [id, `test:${id}`, introId, 'a'.repeat(64)]
    );
    assert.deepEqual(inserted.rows[0], { state: 'planned', version: 1 });

    const initialEvent = await client.query(
      'SELECT from_state, to_state, version FROM voice_intro_migration_journal_events WHERE journal_id = $1',
      [id]
    );
    assert.deepEqual(initialEvent.rows, [{ from_state: null, to_state: 'planned', version: 1 }]);

    await assert.rejects(
      client.query("UPDATE voice_intro_migration_journal SET state = 'staged_authenticated', version = 2, updated_at = statement_timestamp() WHERE id = $1", [id]),
      error => error.code === '23514'
    );

    await client.query('BEGIN');
    const claimed = await client.query(
      `UPDATE voice_intro_migration_journal
       SET state = 'source_authenticated', version = version + 1,
           updated_at = statement_timestamp()
       WHERE id = $1 AND state = 'planned' AND version = 1
       RETURNING state, version, source_authenticated_at`,
      [id]
    );
    assert.equal(claimed.rowCount, 1);
    assert.equal(claimed.rows[0].state, 'source_authenticated');
    await client.query('COMMIT');

    await assert.rejects(
      client.query("UPDATE voice_intro_migration_journal_events SET to_state = 'completed' WHERE journal_id = $1", [id]),
      error => error.code === '55000'
    );

    await client.query('BEGIN');
    const staged = await client.query(
      `UPDATE voice_intro_migration_journal
       SET state = 'staged_authenticated', version = version + 1,
           staged_path = '/private/voice/staging/source.enc',
           staged_sha256 = $2, staged_authenticated_at = statement_timestamp(),
           updated_at = statement_timestamp()
       WHERE id = $1 AND state = 'source_authenticated' AND version = 2
       RETURNING state, version`,
      [id, 'b'.repeat(64)]
    );
    assert.equal(staged.rowCount, 1);
    await client.query('COMMIT');

    const switched = await client.query(
      `UPDATE voice_intro_migration_journal
       SET state = 'reference_switched', version = version + 1,
           updated_at = statement_timestamp()
       WHERE id = $1 AND state = 'staged_authenticated' AND version = 3
       RETURNING state, version, reference_switched_at`,
      [id]
    );
    assert.equal(switched.rowCount, 1);
    assert.equal(switched.rows[0].state, 'reference_switched');

    const events = await client.query(
      'SELECT version, from_state, to_state FROM voice_intro_migration_journal_events WHERE journal_id = $1 ORDER BY version',
      [id]
    );
    assert.deepEqual(events.rows.map(row => row.to_state), [
      'planned', 'source_authenticated', 'staged_authenticated', 'reference_switched'
    ]);
    assert.deepEqual(events.rows.map(row => Number(row.version)), [1, 2, 3, 4]);

    await assert.rejects(
      client.query("UPDATE voice_intro_migration_journal SET state = 'completed', version = version + 1, updated_at = statement_timestamp() WHERE id = $1", [id]),
      error => error.code === '23514'
    );
  } finally {
    if (client) {
      client.release();
    }
    await pool.end();
  }
});
