import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Pool } = pg;

test('verified Didit state requires a persisted live Approved provider session', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS definition, convalidated
       FROM pg_constraint
       WHERE conrelid = 'public.identity_verifications'::regclass
         AND conname = 'identity_verifications_verified_requires_live_approved_session'`
    );
    assert.equal(result.rowCount, 1, 'the L2 integrity constraint must be installed');
    assert.equal(result.rows[0].convalidated, true, 'existing rows must be validated before deployment succeeds');
    const definition = result.rows[0].definition;
    assert.match(definition, /status <> 'verified'/);
    assert.match(definition, /provider_environment = 'live'/);
    assert.match(definition, /provider_status = 'Approved'/);
    assert.match(definition, /provider_session_id IS NOT NULL/);
    assert.match(definition, /IS TRUE/,
      'the verified evidence predicate must reject SQL UNKNOWN from nullable provider_status');

    // Clone the production table constraints so the regression test exercises
    // the actual installed CHECK expression without creating a users fixture.
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TEMP TABLE didit_verified_null_check_test
        (LIKE public.identity_verifications INCLUDING ALL)
      `);
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO didit_verified_null_check_test
         (user_id, workflow_id, provider_session_id, status, provider_status, provider_environment)
         VALUES ($1, $2, $3, 'verified', 'Approved', 'live')`,
        [
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
        ]
      );
      await client.query('SAVEPOINT reject_null_provider_verdict');
      await assert.rejects(
        client.query(
          `INSERT INTO didit_verified_null_check_test
           (user_id, workflow_id, provider_session_id, status, provider_status, provider_environment)
           VALUES ($1, $2, $3, 'verified', NULL, 'live')`,
          [
            'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            'ffffffff-ffff-4fff-8fff-ffffffffffff'
          ]
        ),
        error => error.code === '23514'
      );
      await client.query('ROLLBACK TO SAVEPOINT reject_null_provider_verdict');
      await client.query('COMMIT');
    } finally {
      if (client) {
        try { await client.query('ROLLBACK'); } catch {}
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
});
