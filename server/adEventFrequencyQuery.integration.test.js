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

test('PostgreSQL ad frequency query returns zero counts for a user with no events', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    // Isolate the query from persistent event data.
    await client.query(`
      CREATE TEMP TABLE ad_events (
        event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id text NOT NULL,
        campaign_id text NOT NULL,
        event_type text NOT NULL,
        created_at timestamptz NOT NULL
      ) ON COMMIT PRESERVE ROWS
    `);

    const result = await client.query(
      AD_EVENT_FREQUENCY_COUNTS_SQL,
      ['user-with-no-ad-events', 'campaign-with-no-events']
    );
    assert.deepEqual(result.rows[0], {
      impressions: 0,
      clicks: 0,
      impression_retry_after_seconds: 1,
      click_retry_after_seconds: 1
    });
  } finally {
    await client.end();
  }
});

test('PostgreSQL ad frequency query uses event id to order equal timestamps deterministically', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await client.query(`
      CREATE TEMP TABLE ad_events (
        event_id uuid PRIMARY KEY,
        user_id text NOT NULL,
        campaign_id text NOT NULL,
        event_type text NOT NULL,
        created_at timestamptz NOT NULL
      ) ON COMMIT PRESERVE ROWS
    `);

    const userId = 'frequency-tied-timestamp-user';
    const campaignId = 'frequency-tied-timestamp-campaign';
    await client.query(
      `INSERT INTO ad_events (event_id, user_id, campaign_id, event_type, created_at)
       VALUES
         ('00000000-0000-4000-8000-000000000004', $1, $2, 'impression', NOW() - INTERVAL '1 hour'),
         ('00000000-0000-4000-8000-000000000002', $1, $2, 'impression', NOW() - INTERVAL '1 hour'),
         ('00000000-0000-4000-8000-000000000003', $1, $2, 'impression', NOW() - INTERVAL '1 hour'),
         ('00000000-0000-4000-8000-000000000001', $1, $2, 'impression', NOW() - INTERVAL '1 hour')`,
      [userId, campaignId]
    );

    const result = await client.query(
      `SELECT event_id::text,
              ROW_NUMBER() OVER (ORDER BY created_at ASC, event_id ASC) AS position
       FROM ad_events
       WHERE user_id = $1 AND campaign_id = $2`,
      [userId, campaignId]
    );
    assert.deepEqual(
      result.rows.map(row => [row.event_id, Number(row.position)]),
      [
        ['00000000-0000-4000-8000-000000000001', 1],
        ['00000000-0000-4000-8000-000000000002', 2],
        ['00000000-0000-4000-8000-000000000003', 3],
        ['00000000-0000-4000-8000-000000000004', 4]
      ]
    );

    const counts = await client.query(AD_EVENT_FREQUENCY_COUNTS_SQL, [userId, campaignId]);
    assert.equal(counts.rows[0].impressions, 4);
    assert.ok(counts.rows[0].impression_retry_after_seconds >= 82_790);
    assert.ok(counts.rows[0].impression_retry_after_seconds <= 82_810);
  } finally {
    await client.end();
  }
});

test('PostgreSQL ad frequency query includes the exact 24-hour boundary and excludes older rows', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TEMP TABLE ad_events (
        event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id text NOT NULL,
        campaign_id text NOT NULL,
        event_type text NOT NULL,
        created_at timestamptz NOT NULL
      ) ON COMMIT PRESERVE ROWS
    `);

    const userId = 'frequency-window-boundary-user';
    const campaignId = 'frequency-window-boundary-campaign';
    await client.query(
      `INSERT INTO ad_events (user_id, campaign_id, event_type, created_at)
       VALUES ($1, $2, 'impression', NOW() - INTERVAL '24 hours'),
              ($1, $2, 'impression', NOW() - INTERVAL '24 hours 1 second'),
              ($1, $2, 'click', NOW()),
              ($1, $2, 'click', NOW() + INTERVAL '1 second')`,
      [userId, campaignId]
    );

    const result = await client.query(AD_EVENT_FREQUENCY_COUNTS_SQL, [userId, campaignId]);
    assert.equal(result.rows[0].impressions, 1, 'event exactly 24 hours old remains in the window');
    assert.equal(result.rows[0].clicks, 1, 'event exactly at NOW remains in the window');
    assert.equal(result.rows[0].impression_retry_after_seconds, 1,
      'an event exactly 24 hours old has already reached its expiry boundary');
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
});
