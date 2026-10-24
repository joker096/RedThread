import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { AD_EVENT_FREQUENCY_COUNTS_SQL } from './adEventFrequencyQuery.js';

const { Client } = pg;

test('PostgreSQL ad frequency query computes the expiry that actually clears each cap', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    // A temporary table shadows the production table name in this connection;
    // no persistent users, events, or production data are touched.
    await client.query(`
      CREATE TEMP TABLE ad_events (
        user_id text NOT NULL,
        campaign_id text NOT NULL,
        event_type text NOT NULL,
        created_at timestamptz NOT NULL
      ) ON COMMIT PRESERVE ROWS
    `);

    const userId = 'retry-after-regression-user';
    const campaignId = 'over-cap';
    await client.query(
      `INSERT INTO ad_events (user_id, campaign_id, event_type, created_at)
       SELECT $1, $2, 'impression', NOW() - age * INTERVAL '1 hour'
       FROM unnest(ARRAY[23, 22, 21, 20]::int[]) AS age`,
      [userId, campaignId]
    );
    await client.query(
      `INSERT INTO ad_events (user_id, campaign_id, event_type, created_at)
       SELECT $1, $2, 'click', NOW() - age * INTERVAL '1 hour'
       FROM unnest(ARRAY[23, 22, 21, 20, 19, 18, 17]::int[]) AS age`,
      [userId, campaignId]
    );

    const result = await client.query(AD_EVENT_FREQUENCY_COUNTS_SQL, [userId, campaignId]);
    const counts = result.rows[0];

    assert.equal(counts.impressions, 4);
    assert.equal(counts.clicks, 7);
    // Four impressions exceed the cap of three: one expiry still leaves three,
    // so the retry must wait for the second-oldest impression to expire (~22h age).
    assert.ok(counts.impression_retry_after_seconds >= 7_190);
    assert.ok(counts.impression_retry_after_seconds <= 7_210);
    // Seven clicks exceed the cap of five: the third-oldest expiry is required
    // to bring the count below five (~21h age).
    assert.ok(counts.click_retry_after_seconds >= 10_790);
    assert.ok(counts.click_retry_after_seconds <= 10_810);
  } finally {
    await client.end();
  }
});


test('PostgreSQL enforces gift order and payment terminal-state consistency', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const expected = [
      'gift_orders_refunded_payment_consistency',
      'gift_orders_refund_pending_payment_consistency',
      'gift_orders_declined_payment_inactive',
      'gift_orders_cancelled_payment_inactive'
    ];
    const result = await client.query(
      `SELECT conname
       FROM pg_constraint
       WHERE conrelid = 'gift_delivery_orders'::regclass
         AND conname = ANY($1::text[])
         AND convalidated = TRUE`,
      [expected]
    );
    assert.deepEqual(result.rows.map(row => row.conname).sort(), [...expected].sort());
  } finally {
    await client.end();
  }
});


test('PostgreSQL permits only one pending gift request per unordered match pair', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const result = await client.query(
      `SELECT i.indisunique AS is_unique, pg_get_indexdef(i.indexrelid) AS definition
       FROM pg_index i
       JOIN pg_class idx ON idx.oid = i.indexrelid
       WHERE idx.relname = 'gift_orders_one_pending_per_unordered_pair_idx'`
    );
    assert.equal(result.rowCount, 1);
    assert.equal(result.rows[0].is_unique, true);
    const definition = result.rows[0].definition.toLowerCase();
    assert.match(definition, /least\s*\(sender_id, recipient_id\)/);
    assert.match(definition, /greatest\s*\(sender_id, recipient_id\)/);
    assert.match(definition, /awaiting_recipient_consent/);
  } finally {
    await client.end();
  }
});
