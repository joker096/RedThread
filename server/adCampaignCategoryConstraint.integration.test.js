import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Pool } = pg;

test('PostgreSQL campaign category constraint matches the approved registry allowlist', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    const result = await client.query(
      `SELECT pg_get_constraintdef(oid) AS definition, convalidated
       FROM pg_constraint
       WHERE conrelid = 'ad_campaigns'::regclass
         AND conname = 'ad_campaigns_category_allowlist'`
    );
    assert.equal(result.rowCount, 1, 'migration 039 must install the campaign category allowlist');
    assert.equal(result.rows[0].convalidated, false, 'legacy rows remain unvalidated until separately audited');
    const definition = result.rows[0].definition;
    assert.equal(typeof definition, 'string');
    assert.match(definition, /restaurant/);
    assert.match(definition, /general_local/);

    await client.query('BEGIN');
    try {
      // Use the actual installed CHECK expression on an isolated temporary table.
      await client.query(`
        CREATE TEMP TABLE ad_campaign_category_constraint_test (
          category text NOT NULL,
          CONSTRAINT ad_campaigns_category_allowlist ${definition}
        ) ON COMMIT DROP
      `);

      for (const category of [
        'restaurant', 'cafe', 'date_experience', 'flowers', 'gift',
        'fashion', 'beauty', 'travel', 'general_local'
      ]) {
        await client.query(
          'INSERT INTO ad_campaign_category_constraint_test (category) VALUES ($1)',
          [category]
        );
      }

      for (const category of [
        'political', 'unreviewed_health', 'bridal_dress', 'wedding_venue',
        'legal', 'family_law', 'gambling', 'religious', 'unknown'
      ]) {
        await client.query('SAVEPOINT invalid_campaign_category');
        let insertError;
        try {
          await client.query(
            'INSERT INTO ad_campaign_category_constraint_test (category) VALUES ($1)',
            [category]
          );
        } catch (error) {
          insertError = error;
        }
        assert.equal(insertError?.code, '23514', `unsupported category must be rejected: ${category}`);
        await client.query('ROLLBACK TO SAVEPOINT invalid_campaign_category');
        await client.query('RELEASE SAVEPOINT invalid_campaign_category');
      }

      const allowedCount = await client.query(
        'SELECT COUNT(*)::int AS count FROM ad_campaign_category_constraint_test'
      );
      assert.equal(allowedCount.rows[0].count, 9);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  } finally {
    client.release();
    await pool.end();
  }
});
