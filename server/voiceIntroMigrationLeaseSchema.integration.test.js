import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Pool } = pg;

test('voice intro migration journal leases are exclusive, renewable and fenced', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const journalId = randomUUID();
  const introId = randomUUID();
  const firstToken = randomUUID();
  const secondToken = randomUUID();
  const first = await pool.connect();
  const second = await pool.connect();
  try {
    await first.query(
      `INSERT INTO voice_intro_migration_journal
        (id, idempotency_key, voice_intro_id, source_path, source_sha256, source_format, target_key_id)
       VALUES ($1, $2, $3, '/private/voice/lease-source.enc', $4, 'VOWVOICE1', 'voice-next')`,
      [journalId, `lease-test:${journalId}`, introId, 'c'.repeat(64)]
    );

    const claimSql = `
      WITH candidate AS (
        SELECT id
        FROM voice_intro_migration_journal
        WHERE state NOT IN ('completed', 'rolled_back')
          AND (lease_token IS NULL OR lease_expires_at <= statement_timestamp())
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE voice_intro_migration_journal AS journal
      SET lease_token = $1,
          lease_owner = $2,
          lease_claimed_at = statement_timestamp(),
          lease_expires_at = statement_timestamp() + $3::interval,
          lease_generation = lease_generation + 1
      FROM candidate
      WHERE journal.id = candidate.id
      RETURNING journal.id, journal.lease_generation, journal.lease_expires_at
    `;

    await first.query('BEGIN');
    const firstClaim = await first.query(claimSql, [firstToken, 'worker-a', '30 seconds']);
    assert.equal(firstClaim.rowCount, 1);
    assert.equal(firstClaim.rows[0].id, journalId);

    await second.query('BEGIN');
    const concurrentClaim = await second.query(claimSql, [secondToken, 'worker-b', '30 seconds']);
    assert.equal(concurrentClaim.rowCount, 0, 'SKIP LOCKED must prevent a second worker claiming the row');
    await second.query('COMMIT');
    await first.query('COMMIT');

    const wrongOwnerRenewal = await pool.query(
      `UPDATE voice_intro_migration_journal
       SET lease_expires_at = lease_expires_at + INTERVAL '30 seconds'
       WHERE id = $1 AND lease_token = $2 AND lease_generation = 1
       RETURNING id`,
      [journalId, secondToken]
    );
    assert.equal(wrongOwnerRenewal.rowCount, 0, 'a stale worker token must not renew another worker lease');

    const renewal = await pool.query(
      `UPDATE voice_intro_migration_journal
       SET lease_expires_at = lease_expires_at + INTERVAL '30 seconds'
       WHERE id = $1 AND lease_token = $2 AND lease_generation = 1
       RETURNING lease_generation`,
      [journalId, firstToken]
    );
    assert.equal(renewal.rowCount, 1);
    assert.equal(Number(renewal.rows[0].lease_generation), 1);

    const wrongOwnerRelease = await pool.query(
      `UPDATE voice_intro_migration_journal
       SET lease_token = NULL, lease_owner = NULL, lease_claimed_at = NULL, lease_expires_at = NULL
       WHERE id = $1 AND lease_token = $2 AND lease_generation = 1
       RETURNING id`,
      [journalId, secondToken]
    );
    assert.equal(wrongOwnerRelease.rowCount, 0);

    const release = await pool.query(
      `UPDATE voice_intro_migration_journal
       SET lease_token = NULL, lease_owner = NULL, lease_claimed_at = NULL, lease_expires_at = NULL
       WHERE id = $1 AND lease_token = $2 AND lease_generation = 1
       RETURNING id`,
      [journalId, firstToken]
    );
    assert.equal(release.rowCount, 1);

    const shortLease = await pool.query(claimSql, [secondToken, 'worker-b', '1 millisecond']);
    assert.equal(shortLease.rowCount, 1);
    await new Promise(resolve => setTimeout(resolve, 15));

    const reclaimed = await pool.query(claimSql, [firstToken, 'worker-a', '30 seconds']);
    assert.equal(reclaimed.rowCount, 1, 'expired leases must be reclaimable');
    assert.equal(Number(reclaimed.rows[0].lease_generation), 3, 'each acquisition must advance the fencing generation');

    const staleRelease = await pool.query(
      `UPDATE voice_intro_migration_journal
       SET lease_token = NULL, lease_owner = NULL, lease_claimed_at = NULL, lease_expires_at = NULL
       WHERE id = $1 AND lease_token = $2 AND lease_generation = 2
       RETURNING id`,
      [journalId, secondToken]
    );
    assert.equal(staleRelease.rowCount, 0, 'an expired worker cannot release a newer lease');
  } finally {
    try { await first.query('ROLLBACK'); } catch {}
    try { await second.query('ROLLBACK'); } catch {}
    first.release();
    second.release();
    await pool.end();
  }
});
