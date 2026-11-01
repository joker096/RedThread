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

      const uploadTokenTable = await client.query(
        "SELECT to_regclass('public.identity_l3_upload_tokens') AS tokens"
      );
      assert.equal(uploadTokenTable.rows[0].tokens, 'identity_l3_upload_tokens');
      const uploadTokenColumns = await client.query(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'identity_l3_upload_tokens'`
      );
      const uploadTokenColumnTypes = new Map(uploadTokenColumns.rows.map(row => [row.column_name, row.data_type]));
      assert.equal(uploadTokenColumnTypes.get('token_sha256'), 'character');
      assert.equal(uploadTokenColumnTypes.has('token'), false, 'plaintext bearer tokens must never be stored');
      assert.ok(uploadTokenColumnTypes.has('consumed_at'));
      assert.ok(uploadTokenColumnTypes.has('revoked_at'));
      const uploadTokenForeignKeys = await client.query(
        `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
         WHERE conrelid = 'identity_l3_upload_tokens'::regclass AND contype = 'f'`
      );
      assert.ok(uploadTokenForeignKeys.rows.some(row =>
        /FOREIGN KEY \(submission_id, user_id\)/.test(row.definition) &&
        /REFERENCES identity_l3_submissions\(id, user_id\)/.test(row.definition)
      ), 'upload token owner must be enforced by a composite database foreign key');
      const uploadTokenIndexes = await client.query(
        `SELECT indexname, indexdef FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'identity_l3_upload_tokens'`
      );
      assert.ok(uploadTokenIndexes.rows.some(row =>
        row.indexname === 'identity_l3_upload_tokens_one_active_per_submission_uidx' &&
        /UNIQUE/.test(row.indexdef) && /consumed_at IS NULL/.test(row.indexdef)
      ));
      const uploadTokenTrigger = await client.query(
        `SELECT pg_get_functiondef('guard_identity_l3_upload_token()'::regprocedure) AS definition`
      );
      assert.match(uploadTokenTrigger.rows[0].definition, /token identity is immutable/);
      assert.match(uploadTokenTrigger.rows[0].definition, /cannot be consumed/);
      assert.match(uploadTokenTrigger.rows[0].definition, /cannot be revoked/);

      const columns = await client.query(
        `SELECT column_name, data_type
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'identity_l3_submissions'`
      );
      const columnTypes = new Map(columns.rows.map(row => [row.column_name, row.data_type]));
      assert.equal(columnTypes.get('storage_object_key'), 'text');
      assert.equal(columnTypes.get('media_sha256'), 'character');
      assert.equal(columnTypes.has('video_bytes'), false, 'video content must not be stored in PostgreSQL');
      const eventColumns = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'identity_l3_decision_events'`
      );
      assert.ok(eventColumns.rows.some(row => row.column_name === 'occurred_at'),
        'append-only audit events require a database timestamp');

      const triggerNames = await client.query(
        `SELECT tgname FROM pg_trigger
         WHERE tgrelid = 'identity_l3_submissions'::regclass AND NOT tgisinternal`
      );
      assert.ok(triggerNames.rows.some(row => row.tgname === 'identity_l3_submission_transition_guard'));
      assert.ok(triggerNames.rows.some(row => row.tgname === 'identity_l3_submission_event_recorder'));
      const eventRecorder = await client.query(
        `SELECT pg_get_functiondef('record_identity_l3_submission_event()'::regprocedure) AS definition`
      );
      assert.match(eventRecorder.rows[0].definition, /processing_completed/);
      assert.match(eventRecorder.rows[0].definition, /processing_failed/);
      assert.match(eventRecorder.rows[0].definition, /submitted_for_review/);

      const eventTrigger = await client.query(
        `SELECT tgname FROM pg_trigger
         WHERE tgrelid = 'identity_l3_decision_events'::regclass AND NOT tgisinternal`
      );
      assert.ok(eventTrigger.rows.some(row => row.tgname === 'identity_l3_decision_events_append_only'));
      const eventForeignKeys = await client.query(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
         WHERE conrelid = 'identity_l3_decision_events'::regclass AND contype = 'f'`
      );
      assert.equal(eventForeignKeys.rows.some(row => /actor_user_id/.test(row.definition)), false,
        'actor identifiers must remain immutable when a moderator account is deleted');
      const eventChecks = await client.query(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
         WHERE conrelid = 'identity_l3_decision_events'::regclass AND contype = 'c'`
      );
      assert.ok(eventChecks.rows.some(row => /reason_code/.test(row.definition) && /a-z0-9_/.test(row.definition)),
        'audit reasons must be bounded machine-readable codes, not free-form personal data');
      assert.ok(eventChecks.rows.some(row => /event_type/.test(row.definition) &&
        /actor_user_id/.test(row.definition) && /user_id/.test(row.definition)),
        'applicants may be actors, but approval/rejection actors must be independent reviewers');
      assert.ok(eventChecks.rows.some(row => /actor_user_id IS NOT NULL/.test(row.definition)),
        'approval and rejection audit events must identify their independent reviewer');

      const fn = await client.query(
        `SELECT pg_get_functiondef('guard_identity_l3_submission_transition()'::regprocedure) AS definition`
      );
      const l3DecisionFunction = await client.query(
        `SELECT pg_get_functiondef('identity_l3_current_decision(uuid)'::regprocedure) AS definition`
      );
      assert.match(l3DecisionFunction.rows[0].definition, /COALESCE\(s\.revoked_at, s\.approved_at, s\.reviewed_at\)/);
      assert.match(l3DecisionFunction.rows[0].definition, /COALESCE\(s\.approved_at, s\.reviewed_at\) DESC/);
      assert.match(l3DecisionFunction.rows[0].definition, /FOR SHARE/);
      const l3ActiveFunction = await client.query(
        `SELECT pg_get_functiondef('identity_l3_has_active_approval(uuid)'::regprocedure) AS definition`
      );
      assert.match(l3ActiveFunction.rows[0].definition, /identity_l3_current_decision/);
      const absentL3Decision = await client.query(
        'SELECT identity_l3_has_active_approval($1) AS active',
        ['dddddddd-dddd-4ddd-8ddd-dddddddddddd']
      );
      assert.equal(absentL3Decision.rows[0].active, false);
      assert.match(fn.rows[0].definition, /identity L3 submission identity is immutable/);
      assert.match(fn.rows[0].definition, /independent reviewer/);
      assert.match(fn.rows[0].definition, /moderator decision is immutable/);
      assert.match(fn.rows[0].definition, /invalid identity L3 status transition/);
      assert.match(fn.rows[0].definition, /media metadata is immutable after upload/);
      const decisionConstraints = await client.query(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
         WHERE conrelid = 'identity_l3_submissions'::regclass AND contype = 'c'`
      );
      assert.ok(decisionConstraints.rows.some(row => /decision_reason_code/.test(row.definition)),
        'moderator decisions must carry a bounded reason code');
      assert.ok(decisionConstraints.rows.some(row => /expires_at IS NOT NULL/.test(row.definition)),
        'an approval must have a non-null six-month expiry timestamp');
      assert.ok(decisionConstraints.rows.some(row => /processing_completed_at/.test(row.definition)),
        'review decisions must not bypass completed media processing');
      assert.ok(decisionConstraints.rows.some(row => /failed/.test(row.definition)),
        'processing failure must be represented as a terminal workflow state');

      const indexes = await client.query(
        `SELECT indexname, indexdef FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'identity_l3_submissions'`
      );
      assert.ok(indexes.rows.some(row => row.indexname === 'identity_l3_one_open_submission_per_user_uidx' && /UNIQUE/.test(row.indexdef)));
      assert.ok(indexes.rows.some(row => row.indexname === 'identity_l3_moderation_queue_idx'));
      assert.ok(indexes.rows.some(row => row.indexname === 'identity_l3_expiry_idx'));
      const currentDecisionIndex = indexes.rows.find(row => row.indexname === 'identity_l3_current_decision_idx');
      assert.ok(currentDecisionIndex);
      assert.match(currentDecisionIndex.indexdef, /COALESCE\(approved_at, reviewed_at\) DESC/);
      assert.match(currentDecisionIndex.indexdef, /COALESCE\(revoked_at, approved_at, reviewed_at\)/);

      await client.query('BEGIN');
      try {
        await client.query(`
          CREATE TEMP TABLE identity_l3_upload_token_trigger_test (
            id uuid PRIMARY KEY,
            submission_id uuid NOT NULL,
            user_id uuid NOT NULL,
            token_sha256 char(64) NOT NULL,
            created_at timestamptz NOT NULL,
            expires_at timestamptz NOT NULL,
            consumed_at timestamptz,
            revoked_at timestamptz
          ) ON COMMIT DROP
        `);
        await client.query(`
          CREATE TRIGGER identity_l3_upload_token_guard_test
          BEFORE INSERT OR UPDATE ON identity_l3_upload_token_trigger_test
          FOR EACH ROW EXECUTE FUNCTION guard_identity_l3_upload_token()
        `);
        const tokenId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
        await client.query(
          `INSERT INTO identity_l3_upload_token_trigger_test
           (id, submission_id, user_id, token_sha256, created_at, expires_at)
           VALUES ($1, $2, $3, repeat('a', 64), NOW(), NOW() + INTERVAL '10 minutes')`,
          [tokenId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']
        );
        await client.query('SAVEPOINT reject_l3_token_hash_mutation');
        await assert.rejects(
          client.query(
            `UPDATE identity_l3_upload_token_trigger_test
             SET token_sha256 = repeat('b', 64) WHERE id = $1`,
            [tokenId]
          ),
          error => error.code === '23514'
        );
        await client.query('ROLLBACK TO SAVEPOINT reject_l3_token_hash_mutation');
        await client.query('RELEASE SAVEPOINT reject_l3_token_hash_mutation');
        await client.query(
          'UPDATE identity_l3_upload_token_trigger_test SET consumed_at = NOW() WHERE id = $1',
          [tokenId]
        );
        await client.query('SAVEPOINT reject_l3_token_replay');
        await assert.rejects(
          client.query(
            'UPDATE identity_l3_upload_token_trigger_test SET consumed_at = consumed_at + INTERVAL '1 second' WHERE id = $1',
            [tokenId]
          ),
          error => error.code === '23514'
        );
        await client.query('ROLLBACK TO SAVEPOINT reject_l3_token_replay');
        await client.query('RELEASE SAVEPOINT reject_l3_token_replay');
        await client.query('SAVEPOINT reject_l3_token_revoke_after_consume');
        await assert.rejects(
          client.query(
            'UPDATE identity_l3_upload_token_trigger_test SET revoked_at = NOW() WHERE id = $1',
            [tokenId]
          ),
          error => error.code === '23514'
        );
        await client.query('ROLLBACK TO SAVEPOINT reject_l3_token_revoke_after_consume');
        await client.query('RELEASE SAVEPOINT reject_l3_token_revoke_after_consume');

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
        await client.query('SAVEPOINT reject_early_l3_purge');
        await assert.rejects(
          client.query(
            `UPDATE identity_l3_submission_trigger_test
             SET storage_object_key = NULL, media_purged_at = NOW() WHERE id = $1`,
            [submissionId]
          ),
          error => error.code === '23514'
        );
        await client.query('ROLLBACK TO SAVEPOINT reject_early_l3_purge');
        await client.query('RELEASE SAVEPOINT reject_early_l3_purge');
        await client.query(
          `UPDATE identity_l3_submission_trigger_test
           SET status = 'processing', processing_completed_at = NOW() WHERE id = $1`,
          [submissionId]
        );
        await client.query(
          "UPDATE identity_l3_submission_trigger_test SET status = 'pending_review' WHERE id = $1",
          [submissionId]
        );
        await client.query(
          `UPDATE identity_l3_submission_trigger_test
           SET status = 'rejected', reviewed_by = $2, reviewed_at = NOW(),
               decision_reason_code = 'integration_test_rejected'
           WHERE id = $1`,
          [submissionId, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc']
        );
        await client.query(
          `UPDATE identity_l3_submission_trigger_test
           SET storage_object_key = NULL, media_purged_at = NOW() WHERE id = $1`,
          [submissionId]
        );

        await client.query(`
          CREATE TEMP TABLE identity_l3_event_parent_test (id integer PRIMARY KEY)
          ON COMMIT DROP
        `);
        await client.query(`
          CREATE TEMP TABLE identity_l3_event_trigger_test (
            id integer PRIMARY KEY,
            parent_id integer NOT NULL REFERENCES identity_l3_event_parent_test(id) ON DELETE CASCADE,
            event_type text
          ) ON COMMIT DROP
        `);
        await client.query(`
          CREATE TRIGGER identity_l3_event_append_only_test
          BEFORE UPDATE OR DELETE ON identity_l3_event_trigger_test
          FOR EACH ROW EXECUTE FUNCTION prevent_identity_l3_decision_event_mutation()
        `);
        await client.query('INSERT INTO identity_l3_event_parent_test (id) VALUES (1)');
        await client.query("INSERT INTO identity_l3_event_trigger_test (id, parent_id, event_type) VALUES (1, 1, 'created')");
        await client.query('SAVEPOINT reject_l3_event_mutation');
        await assert.rejects(
          client.query("UPDATE identity_l3_event_trigger_test SET event_type = 'approved' WHERE id = 1"),
          error => error.code === '55000'
        );
        await client.query('ROLLBACK TO SAVEPOINT reject_l3_event_mutation');
        await client.query('RELEASE SAVEPOINT reject_l3_event_mutation');
        await client.query('SAVEPOINT reject_direct_l3_event_delete');
        await assert.rejects(
          client.query('DELETE FROM identity_l3_event_trigger_test WHERE id = 1'),
          error => error.code === '55000'
        );
        await client.query('ROLLBACK TO SAVEPOINT reject_direct_l3_event_delete');
        await client.query('RELEASE SAVEPOINT reject_direct_l3_event_delete');
        await client.query('DELETE FROM identity_l3_event_parent_test WHERE id = 1');
        const cascadedEvents = await client.query('SELECT COUNT(*)::int AS count FROM identity_l3_event_trigger_test');
        assert.equal(cascadedEvents.rows[0].count, 0,
          'account/submission privacy deletion must be able to cascade dependent audit rows');
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
