import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Pool } = pg;

test('PostgreSQL consent history accepts normalized snapshots and rejects malformed or inconsistent snapshots', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const constraint = await client.query(
      `SELECT convalidated, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'ad_consent_history'::regclass
         AND conname = 'ad_consent_history_preferences_valid'`
    );
    assert.equal(constraint.rowCount, 1, 'migration must install consent snapshot validation');
    assert.equal(constraint.rows[0].convalidated, false, 'legacy snapshots are not implicitly certified');
    assert.match(constraint.rows[0].definition, /is_valid_ad_consent_history_preferences/);

    const valid = {
      adsConsent: true,
      dateOffersConsent: true,
      weddingOffersConsent: false,
      marriagePlanningOptIn: false,
      categoryConsents: { travel: true }
    };
    const cases = [
      [valid, true],
      [{ ...valid, extraField: true }, false],
      [{ ...valid, dateOffersConsent: 'true' }, false],
      [{ ...valid, categoryConsents: { political: true } }, false],
      [{ ...valid, categoryConsents: { travel: 'true' } }, false],
      [{ ...valid, marriagePlanningOptIn: true }, false],
      [{ ...valid, adsConsent: false }, false],
      [{ ...valid, categoryConsents: [] }, false]
    ];

    for (const [snapshot, expected] of cases) {
      const result = await client.query(
        'SELECT is_valid_ad_consent_history_preferences($1::jsonb) AS valid',
        [JSON.stringify(snapshot)]
      );
      assert.equal(result.rows[0].valid, expected, `unexpected validation result for ${JSON.stringify(snapshot)}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
});
