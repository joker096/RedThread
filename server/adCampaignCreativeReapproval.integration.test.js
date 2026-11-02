import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

test('PostgreSQL requires classified creatives and invalidates approval after creative changes', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const campaignId = `creative-context-test-${randomUUID()}`;

  try {
    await client.query('BEGIN');

    const constraint = await client.query(
      `SELECT pg_get_constraintdef(oid) AS definition, convalidated
       FROM pg_constraint
       WHERE conrelid = 'ad_campaigns'::regclass
         AND conname = 'ad_campaigns_creative_context_check'`
    );
    assert.equal(constraint.rowCount, 1, 'migration 047 must install creative-context classification');
    assert.equal(constraint.rows[0].convalidated, false, 'legacy rows remain unvalidated until separately classified');

    const insertCampaign = async creativeContext => client.query(
      `INSERT INTO ad_campaigns
         (id, advertiser_id, advertiser_verified, status, category, creative_version,
          creative_approved, creative_context, allowed_country_codes, starts_at, ends_at)
       VALUES ($1, $2, TRUE, 'approved', 'fashion', 'creative-v1',
               TRUE, $3, ARRAY['GE'], NOW() - INTERVAL '1 hour', NOW() + INTERVAL '1 day')`,
      [campaignId, randomUUID(), creativeContext]
    );

    for (const creativeContext of [null, 'unclassified']) {
      await client.query('SAVEPOINT invalid_creative_context');
      let insertError;
      try {
        await insertCampaign(creativeContext);
      } catch (error) {
        insertError = error;
      }
      assert.equal(insertError?.code, '23514', `new campaign must reject creative context ${String(creativeContext)}`);
      await client.query('ROLLBACK TO SAVEPOINT invalid_creative_context');
      await client.query('RELEASE SAVEPOINT invalid_creative_context');
    }

    await insertCampaign('general');

    const assertApprovalReset = async () => {
      const result = await client.query(
        'SELECT status, creative_approved FROM ad_campaigns WHERE id = $1',
        [campaignId]
      );
      assert.deepEqual(result.rows[0], { status: 'pending', creative_approved: false });
    };
    const reapprove = () => client.query(
      "UPDATE ad_campaigns SET status = 'approved', creative_approved = TRUE WHERE id = $1",
      [campaignId]
    );

    await client.query("UPDATE ad_campaigns SET creative_context = 'bridal' WHERE id = $1", [campaignId]);
    await assertApprovalReset();
    await reapprove();

    await client.query("UPDATE ad_campaigns SET creative_version = 'creative-v2' WHERE id = $1", [campaignId]);
    await assertApprovalReset();
    await reapprove();

    await client.query("UPDATE ad_campaigns SET category = 'beauty' WHERE id = $1", [campaignId]);
    await assertApprovalReset();

    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
});
