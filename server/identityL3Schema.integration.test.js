import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Pool } = pg;

test('L3 schema persists metadata only and protects workflow decisions', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const client = await pool.connect();
    try {
      const tables = await client.query(
        `SELECT to_regclass('public.identity_l3_submissions') AS submissions,
                to_regclass('public.identity_l3_decision_events') AS events`
      );
      assert.equal(tables.rows[0].submissions, 'identity_l3_submissions');
      assert.equal(tables.rows[0].events, 'identity_l3_decision_events');

      const columns = await client.query(
        `SELECT column_name, data_type
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'identity_l3_submissions'`
      );
      const columnTypes = new Map(columns.rows.map(row => [row.column_name, row.data_type]));
      assert.equal(columnTypes.get('storage_object_key'), 'text');
      assert.equal(columnTypes.get('media_sha256'), 'character');
      assert.equal(columnTypes.has('video_bytes'), false, 'video content must not be stored in PostgreSQL');

      const triggerNames = await client.query(
        `SELECT tgname FROM pg_trigger
         WHERE tgrelid = 'identity_l3_submissions'::regclass AND NOT tgisinternal`
      );
      assert.ok(triggerNames.rows.some(row => row.tgname === 'identity_l3_submission_transition_guard'));

      const eventTrigger = await client.query(
        `SELECT tgname FROM pg_trigger
         WHERE tgrelid = 'identity_l3_decision_events'::regclass AND NOT tgisinternal`
      );
      assert.ok(eventTrigger.rows.some(row => row.tgname === 'identity_l3_decision_events_append_only'));

      const fn = await client.query(
        `SELECT pg_get_functiondef('guard_identity_l3_submission_transition()'::regprocedure) AS definition`
      );
      assert.match(fn.rows[0].definition, /identity L3 submission identity is immutable/);
      assert.match(fn.rows[0].definition, /independent reviewer/);
      assert.match(fn.rows[0].definition, /moderator decision is immutable/);
      assert.match(fn.rows[0].definition, /invalid identity L3 status transition/);

      const indexes = await client.query(
        `SELECT indexname, indexdef FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'identity_l3_submissions'`
      );
      assert.ok(indexes.rows.some(row => row.indexname === 'identity_l3_one_open_submission_per_user_uidx' && /UNIQUE/.test(row.indexdef)));
      assert.ok(indexes.rows.some(row => row.indexname === 'identity_l3_moderation_queue_idx'));
      assert.ok(indexes.rows.some(row => row.indexname === 'identity_l3_expiry_idx'));
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
});
