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

      await client.query('BEGIN');
      try {
        await client.query(`
          CREATE TEMP TABLE identity_l3_submission_trigger_test (
            id uuid PRIMARY KEY,
            user_id uuid NOT NULL,
            status text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT NOW(),
            updated_at timestamptz NOT NULL DEFAULT NOW(),
            reviewed_by uuid,
            reviewed_at timestamptz,
            decision_reason_code text,
            approved_at timestamptz,
            expires_at timestamptz,
            storage_object_key text,
            media_sha256 char(64),
            media_mime_type text,
            media_size_bytes bigint,
            media_duration_seconds smallint,
            uploaded_at timestamptz,
            processing_completed_at timestamptz,
            media_purged_at timestamptz
          ) ON COMMIT DROP
        `);
        await client.query(`
          CREATE TRIGGER identity_l3_submission_guard_test
          BEFORE INSERT OR UPDATE ON identity_l3_submission_trigger_test
          FOR EACH ROW EXECUTE FUNCTION guard_identity_l3_submission_transition()
        `);
        const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        const submissionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
        await client.query(
          'INSERT INTO identity_l3_submission_trigger_test (id, user_id, status) VALUES ($1, $2, $3)',
          [submissionId, ownerId, 'draft']
        );
        await client.query('SAVEPOINT reject_invalid_l3_transition');
        await assert.rejects(
          client.query(
            'UPDATE identity_l3_submission_trigger_test SET status = $1 WHERE id = $2',
            ['approved', submissionId]
          ),
          error => error.code === '23514'
        );
        await client.query('ROLLBACK TO SAVEPOINT reject_invalid_l3_transition');
        await client.query('RELEASE SAVEPOINT reject_invalid_l3_transition');

        await client.query(
          'UPDATE identity_l3_submission_trigger_test SET status = $1 WHERE id = $2',
          ['upload_authorized', submissionId]
        );
        await client.query(
          `UPDATE identity_l3_submission_trigger_test
           SET status = 'uploaded', storage_object_key = 'private/l3/test-object',
               media_sha256 = repeat('a', 64), media_mime_type = 'video/mp4',
               media_size_bytes = 1024, media_duration_seconds = 30, uploaded_at = NOW()
           WHERE id = $1`,
          [submissionId]
        );
        await client.query('SAVEPOINT reject_l3_media_replacement');
        await assert.rejects(
          client.query(
            `UPDATE identity_l3_submission_trigger_test
             SET media_sha256 = repeat('b', 64) WHERE id = $1`,
            [submissionId]
          ),
          error => error.code === '23514'
        );
        await client.query('ROLLBACK TO SAVEPOINT reject_l3_media_replacement');
        await client.query('RELEASE SAVEPOINT reject_l3_media_replacement');
        await client.query(
          `UPDATE identity_l3_submission_trigger_test
           SET storage_object_key = NULL, media_purged_at = NOW() WHERE id = $1`,
          [submissionId]
        );

        await client.query(`
          CREATE TEMP TABLE identity_l3_event_trigger_test (id integer PRIMARY KEY, event_type text)
          ON COMMIT DROP
        `);
        await client.query(`
          CREATE TRIGGER identity_l3_event_append_only_test
          BEFORE UPDATE OR DELETE ON identity_l3_event_trigger_test
          FOR EACH ROW EXECUTE FUNCTION prevent_identity_l3_decision_event_mutation()
        `);
        await client.query("INSERT INTO identity_l3_event_trigger_test (id, event_type) VALUES (1, 'created')");
        await client.query('SAVEPOINT reject_l3_event_mutation');
        await assert.rejects(
          client.query("UPDATE identity_l3_event_trigger_test SET event_type = 'approved' WHERE id = 1"),
          error => error.code === '55000'
        );
        await client.query('ROLLBACK TO SAVEPOINT reject_l3_event_mutation');
        await client.query('RELEASE SAVEPOINT reject_l3_event_mutation');
      } finally {
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
});
