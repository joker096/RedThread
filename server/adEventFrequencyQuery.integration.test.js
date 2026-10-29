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
        event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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

    // Future-dated rows must not count toward the current rolling window.
    await client.query(
      `INSERT INTO ad_events (user_id, campaign_id, event_type, created_at)
       VALUES ($1, $2, 'impression', NOW() + INTERVAL '1 hour'),
              ($1, $2, 'click', NOW() + INTERVAL '2 hours')`,
      [userId, campaignId]
    );

    // Events from other users or campaigns must not consume this viewer's cap.
    await client.query(
      `INSERT INTO ad_events (user_id, campaign_id, event_type, created_at)
       VALUES ($1, $2, 'impression', NOW()),
              ($1, $2, 'click', NOW()),
              ($3, $4, 'impression', NOW()),
              ($3, $4, 'click', NOW())`,
      [userId, 'other-campaign', 'other-user', campaignId]
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

test('PostgreSQL enforces sender-scoped idempotency keys for gift orders', {
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
       JOIN pg_class tbl ON tbl.oid = i.indrelid
       WHERE tbl.relname = 'gift_delivery_orders'
         AND idx.relname = 'gift_delivery_orders_sender_id_idempotency_key_key'`
    );
    assert.equal(result.rowCount, 1, 'sender/idempotency unique index must exist');
    assert.equal(result.rows[0].is_unique, true);
    const definition = result.rows[0].definition.toLowerCase();
    assert.match(definition, /sender_id/);
    assert.match(definition, /idempotency_key/);
  } finally {
    await client.end();
  }
});



test('PostgreSQL unordered-pair uniqueness rejects a reverse-direction pending request', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    // Exercise the same expression/partial-index rule in an isolated table so
    // the behavior test never inserts synthetic orders into persistent data.
    await client.query(`
      CREATE TEMP TABLE gift_pending_pair_probe (
        match_id uuid NOT NULL,
        sender_id uuid NOT NULL,
        recipient_id uuid NOT NULL,
        status text NOT NULL
      ) ON COMMIT PRESERVE ROWS
    `);
    await client.query(`
      CREATE UNIQUE INDEX gift_pending_pair_probe_unique_idx
      ON gift_pending_pair_probe (
        match_id,
        LEAST(sender_id, recipient_id),
        GREATEST(sender_id, recipient_id)
      )
      WHERE status = 'awaiting_recipient_consent'
    `);

    const matchId = '00000000-0000-4000-8000-000000000001';
    const senderA = '00000000-0000-4000-8000-00000000000a';
    const senderB = '00000000-0000-4000-8000-00000000000b';
    const otherMatch = '00000000-0000-4000-8000-000000000002';

    await client.query(
      'INSERT INTO gift_pending_pair_probe VALUES ($1, $2, $3, $4)',
      [matchId, senderA, senderB, 'awaiting_recipient_consent']
    );

    await assert.rejects(
      client.query(
        'INSERT INTO gift_pending_pair_probe VALUES ($1, $2, $3, $4)',
        [matchId, senderB, senderA, 'awaiting_recipient_consent']
      ),
      error => error.code === '23505'
    );

    // A different match is independent; a non-pending row is outside the index.
    await client.query(
      'INSERT INTO gift_pending_pair_probe VALUES ($1, $2, $3, $4)',
      [otherMatch, senderB, senderA, 'awaiting_recipient_consent']
    );
    await client.query(
      'INSERT INTO gift_pending_pair_probe VALUES ($1, $2, $3, $4)',
      [matchId, senderB, senderA, 'declined']
    );

    const result = await client.query('SELECT COUNT(*)::int AS count FROM gift_pending_pair_probe');
    assert.equal(result.rows[0].count, 3);
  } finally {
    await client.end();
  }
});
