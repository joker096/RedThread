import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Pool } = pg;

test('PostgreSQL current consent preferences enforce the normalized snapshot schema', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const constraint = await client.query(
      `SELECT convalidated, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'ad_consent_preferences'::regclass
         AND conname = 'ad_consent_preferences_snapshot_valid'`
    );
    assert.equal(constraint.rowCount, 1, 'migration must install current preference validation');
    assert.equal(constraint.rows[0].convalidated, false, 'legacy preferences are not implicitly certified');
    assert.match(constraint.rows[0].definition, /is_valid_ad_consent_history_preferences/);

    const cases = [
      [{ adsConsent: true, dateOffersConsent: false, weddingOffersConsent: false, marriagePlanningOptIn: false, categoryConsents: { travel: true } }, true],
      [{ adsConsent: true, dateOffersConsent: false, weddingOffersConsent: false, marriagePlanningOptIn: false, categoryConsents: { political: true } }, false],
      [{ adsConsent: true, dateOffersConsent: false, weddingOffersConsent: false, marriagePlanningOptIn: false, categoryConsents: { travel: 'true' } }, false],
      [{ adsConsent: false, dateOffersConsent: false, weddingOffersConsent: false, marriagePlanningOptIn: false, categoryConsents: { travel: true } }, false],
      [{ adsConsent: true, dateOffersConsent: false, weddingOffersConsent: false, marriagePlanningOptIn: true, categoryConsents: {} }, false]
    ];

    for (const [snapshot, expected] of cases) {
      const result = await client.query(
        `SELECT is_valid_ad_consent_history_preferences(
          jsonb_build_object(
            'adsConsent', $1::jsonb -> 'adsConsent',
            'dateOffersConsent', $1::jsonb -> 'dateOffersConsent',
            'weddingOffersConsent', $1::jsonb -> 'weddingOffersConsent',
            'marriagePlanningOptIn', $1::jsonb -> 'marriagePlanningOptIn',
            'categoryConsents', $1::jsonb -> 'categoryConsents'
          )
        ) AS valid`,
        [JSON.stringify(snapshot)]
      );
      assert.equal(result.rows[0].valid, expected, `unexpected validation result for ${JSON.stringify(snapshot)}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
});
