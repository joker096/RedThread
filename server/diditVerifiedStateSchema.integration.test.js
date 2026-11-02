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
  } finally {
    await pool.end();
  }
});
