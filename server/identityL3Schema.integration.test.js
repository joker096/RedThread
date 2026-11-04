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

      const consentTables = await client.query(
        `SELECT to_regclass('public.identity_l3_consents') AS current_consent,
                to_regclass('public.identity_l3_consent_events') AS consent_events`
      );
      assert.equal(consentTables.rows[0].current_consent, 'identity_l3_consents');
      assert.equal(consentTables.rows[0].consent_events, 'identity_l3_consent_events');
      const consentColumns = await client.query(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'identity_l3_consents'`
      );
      const consentColumnNames = new Set(consentColumns.rows.map(row => row.column_name));
      assert.ok(consentColumnNames.has('consent_version'));
      assert.ok(consentColumnNames.has('granted_at'));
      assert.ok(consentColumnNames.has('withdrawn_at'));
      const consentAuditTrigger = await client.query(
        `SELECT tgname FROM pg_trigger
         WHERE tgrelid = 'identity_l3_consent_events'::regclass AND NOT tgisinternal`
      );
      assert.ok(consentAuditTrigger.rows.some(row => row.tgname === 'identity_l3_consent_events_append_only'));
      const consentTruncateGuard = await client.query(
        `SELECT tgname FROM pg_trigger
         WHERE tgrelid = 'identity_l3_consent_events'::regclass AND NOT tgisinternal`
      );
      assert.ok(consentTruncateGuard.rows.some(row =>
        row.tgname === 'identity_l3_consent_events_no_truncate'
      ), 'consent audit history must also be protected from TRUNCATE');
      const consentAuditGuard = await client.query(
        `SELECT pg_get_functiondef('prevent_identity_l3_consent_event_mutation()'::regprocedure) AS definition`
      );
      assert.match(consentAuditGuard.rows[0].definition, /consent events are append-only/);
      assert.match(consentAuditGuard.rows[0].definition, /u\.status = 'deleted'/,
        'account deletion may purge consent audit history only after marking the account deleted');

      const mediaAccessAudit = await client.query(
        `SELECT to_regclass('public.identity_l3_media_access_events') AS access_events`
      );
      assert.equal(mediaAccessAudit.rows[0].access_events, 'identity_l3_media_access_events');
      await assert.rejects(
        client.query(`INSERT INTO identity_l3_media_access_events
          (submission_ref, moderator_ref, access_type)
         VALUES (
           'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
           'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
           'viewed'
         )`),
        error => error.code === '23502'
      );
      const mediaAccessTrigger = await client.query(
        `SELECT tgname FROM pg_trigger
         WHERE tgrelid = 'identity_l3_media_access_events'::regclass AND NOT tgisinternal`
      );
      assert.ok(mediaAccessTrigger.rows.some(row =>
        row.tgname === 'identity_l3_media_access_events_append_only'
      ));
      const purgeQueueTable = await client.query(
        "SELECT to_regclass('public.identity_l3_media_purge_jobs') AS purge_jobs"
      );
      assert.equal(purgeQueueTable.rows[0].purge_jobs, 'identity_l3_media_purge_jobs');
      const purgeQueueTriggerNames = await client.query(
        `SELECT tgname FROM pg_trigger
         WHERE tgrelid = 'identity_l3_media_purge_jobs'::regclass AND NOT tgisinternal`
      );
      assert.ok(purgeQueueTriggerNames.rows.some(row =>
        row.tgname === 'identity_l3_media_purge_jobs_no_delete'
      ), 'pending and failed media purge work must not be deleted');
      assert.ok(purgeQueueTriggerNames.rows.some(row =>
        row.tgname === 'identity_l3_media_purge_jobs_no_truncate'
      ), 'media purge queue must not be truncated');
      const submissionDeleteTriggers = await client.query(
        `SELECT tgname FROM pg_trigger
         WHERE tgrelid = 'identity_l3_submissions'::regclass AND NOT tgisinternal`
      );
      assert.ok(submissionDeleteTriggers.rows.some(row =>
        row.tgname === 'identity_l3_submissions_retain_live_media'
      ), 'a submission with a live encrypted object must not be deleted');
      assert.ok(submissionDeleteTriggers.rows.some(row =>
        row.tgname === 'identity_l3_submissions_no_truncate'
      ), 'L3 submission rows must not be truncated around the purge workflow');
      const purgeEnqueueTrigger = await client.query(
        `SELECT tgname FROM pg_trigger
         WHERE tgrelid = 'identity_l3_submissions'::regclass AND NOT tgisinternal`
      );
      assert.ok(purgeEnqueueTrigger.rows.some(row =>
        row.tgname === 'identity_l3_submission_enqueue_media_purge'
      ), 'terminal media must automatically enter the durable purge queue');
      const purgeEnqueueFunction = await client.query(
        `SELECT pg_get_functiondef('enqueue_identity_l3_media_purge()'::regprocedure) AS definition`
      );
      for (const terminalStatus of ['rejected', 'withdrawn', 'revoked', 'expired', 'failed']) {
        assert.match(purgeEnqueueFunction.rows[0].definition, new RegExp(terminalStatus));
      }
      assert.doesNotMatch(purgeEnqueueFunction.rows[0].definition, /approved/,
        'an active six-month approval must retain its encrypted evidence');
      const purgeQueueIndexes = await client.query(
        `SELECT indexname, indexdef FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'identity_l3_media_purge_jobs'`
      );
      assert.ok(purgeQueueIndexes.rows.some(row =>
        row.indexname === 'identity_l3_media_purge_queue_idx' &&
        /status (?:= ANY|IN)/.test(row.indexdef) && /queued/.test(row.indexdef) && /processing/.test(row.indexdef)
      ));
      const purgeQueueColumns = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'identity_l3_media_purge_jobs'`
      );
      const purgeQueueColumnNames = new Set(purgeQueueColumns.rows.map(row => row.column_name));
      for (const name of ['attempts', 'next_attempt_at', 'lease_token', 'lease_expires_at', 'last_error_code', 'completed_at']) {
        assert.ok(purgeQueueColumnNames.has(name), 'purge queue must persist ' + name);
      }
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
      assert.equal(columnTypes.get('processing_attempts'), 'smallint');
      assert.equal(columnTypes.get('processing_lease_token'), 'uuid');
      assert.equal(columnTypes.get('processing_lease_expires_at'), 'timestamp with time zone');
      assert.equal(columnTypes.get('processing_next_attempt_at'), 'timestamp with time zone');
      assert.equal(columnTypes.has('processing_last_error_code'), true);
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
      assert.match(eventRecorder.rows[0].definition, /OLD\.status = 'processing'/,
        'processing completion must be recorded only after the processing state finishes');
      assert.match(eventRecorder.rows[0].definition, /processing_failed/);
      assert.match(eventRecorder.rows[0].definition, /submitted_for_review/);

      const eventTrigger = await client.query(
        `SELECT tgname FROM pg_trigger
         WHERE tgrelid = 'identity_l3_decision_events'::regclass AND NOT tgisinternal`
      );
      assert.ok(eventTrigger.rows.some(row => row.tgname === 'identity_l3_decision_events_append_only'));
      const decisionEventTruncateGuard = await client.query(
        `SELECT tgname FROM pg_trigger
         WHERE tgrelid = 'identity_l3_decision_events'::regclass AND NOT tgisinternal`
      );
      assert.ok(decisionEventTruncateGuard.rows.some(row =>
        row.tgname === 'identity_l3_decision_events_no_truncate'
      ), 'L3 decision history must also be protected from TRUNCATE');
      const decisionEventInsertGuard = await client.query(
        `SELECT tgname FROM pg_trigger
         WHERE tgrelid = 'identity_l3_decision_events'::regclass AND NOT tgisinternal`
      );
      assert.ok(decisionEventInsertGuard.rows.some(row =>
        row.tgname === 'identity_l3_decision_events_source_insert_guard'
      ), 'decision events must be emitted only by the guarded submission transition trigger');
      const decisionEventSourceFunction = await client.query(
        `SELECT pg_get_functiondef('require_identity_l3_decision_event_source()'::regprocedure) AS definition`
      );
      assert.match(decisionEventSourceFunction.rows[0].definition, /pg_trigger_depth\(\) <= 1/);
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
      assert.match(l3DecisionFunction.rows[0].definition, /COALESCE\(s\.approved_at, s\.reviewed_at\) DESC NULLS LAST/);
      assert.match(l3DecisionFunction.rows[0].definition, /s\.status <> 'expired' OR s\.approved_at IS NOT NULL/,
        'pending-review retention expiry must not supersede an earlier valid approval');
      assert.match(l3DecisionFunction.rows[0].definition, /FOR SHARE/);
      const l3ActiveFunction = await client.query(
        `SELECT pg_get_functiondef('identity_l3_has_active_approval(uuid)'::regprocedure) AS definition`
      );
      assert.match(l3ActiveFunction.rows[0].definition, /identity_l3_current_decision/);
      assert.match(l3ActiveFunction.rows[0].definition, /identity_l3_consents/);
      assert.match(l3ActiveFunction.rows[0].definition, /consent_version = 2/);
      assert.match(l3ActiveFunction.rows[0].definition, /withdrawn_at IS NULL/);
      const absentL3Decision = await client.query(
        'SELECT identity_l3_has_active_approval($1) AS active',
        ['dddddddd-dddd-4ddd-8ddd-dddddddddddd']
      );
      assert.equal(absentL3Decision.rows[0].active, false);
      assert.match(fn.rows[0].definition, /identity L3 submission identity is immutable/);
      assert.match(fn.rows[0].definition, /independent reviewer/);
      assert.match(fn.rows[0].definition, /moderator decision is immutable/);
      assert.match(fn.rows[0].definition, /invalid identity L3 status transition/);
      assert.match(fn.rows[0].definition, /NEW\.status = 'revoked' AND NEW\.status IS DISTINCT FROM OLD\.status AND OLD\.status <> 'approved'/,
        'purging an already-revoked submission must not be mistaken for a new revocation');
      assert.match(fn.rows[0].definition, /media metadata is immutable after upload/);
      assert.match(fn.rows[0].definition, /OLD\.status = 'processing'/,
        'the worker may set duration only while completing processing');
      assert.match(fn.rows[0].definition, /OLD\.media_duration_seconds IS NULL/,
        'a validated duration may be written only once');
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
      const validatedDurationConstraint = decisionConstraints.rows.find(row =>
        row.definition.includes('media_duration_seconds IS NOT NULL')
      );
      assert.ok(validatedDurationConstraint,
        'the review-state duration constraint must require an explicit validated duration');
      assert.match(validatedDurationConstraint.definition, /media_duration_seconds IS NOT NULL/);
      assert.match(validatedDurationConstraint.definition, /media_duration_seconds >= 30/);
      assert.match(validatedDurationConstraint.definition, /media_duration_seconds <= 60/);
      assert.ok(decisionConstraints.rows.some(row => /failed/.test(row.definition)),
        'processing failure must be represented as a terminal workflow state');

      const indexes = await client.query(
        `SELECT indexname, indexdef FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'identity_l3_submissions'`
      );
      assert.ok(indexes.rows.some(row => row.indexname === 'identity_l3_one_open_submission_per_user_uidx' && /UNIQUE/.test(row.indexdef)));
      assert.ok(indexes.rows.some(row => row.indexname === 'identity_l3_moderation_queue_idx'));
      const processingQueueIndex = indexes.rows.find(row => row.indexname === 'identity_l3_processing_queue_idx');
      assert.ok(processingQueueIndex, 'uploaded and retryable processing rows need an indexed worker queue');
      assert.match(processingQueueIndex.indexdef, /status = ANY \(ARRAY\['uploaded'::text, 'processing'::text\]\)/);
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
            `UPDATE identity_l3_upload_token_trigger_test SET consumed_at = consumed_at + INTERVAL '1 second' WHERE id = $1`,
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
          ALTER TABLE identity_l3_submission_trigger_test
          ADD CONSTRAINT identity_l3_review_requires_validated_duration_check
          CHECK (
            status NOT IN ('pending_review', 'approved', 'rejected')
            OR (media_duration_seconds IS NOT NULL AND media_duration_seconds BETWEEN 30 AND 60)
          )
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
               media_size_bytes = 1024, media_duration_seconds = NULL, uploaded_at = NOW()
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
          "UPDATE identity_l3_submission_trigger_test SET status = 'processing' WHERE id = $1",
          [submissionId]
        );
        await client.query('SAVEPOINT reject_early_l3_processing_completion');
        await assert.rejects(
          client.query(
            'UPDATE identity_l3_submission_trigger_test SET processing_completed_at = NOW() WHERE id = $1',
            [submissionId]
          ),
          error => error.code === '23514'
        );
        await client.query('ROLLBACK TO SAVEPOINT reject_early_l3_processing_completion');
        await client.query('RELEASE SAVEPOINT reject_early_l3_processing_completion');
        await client.query('SAVEPOINT reject_unprobed_l3_submission');
        await assert.rejects(
          client.query(
            `UPDATE identity_l3_submission_trigger_test
             SET status = 'pending_review', processing_completed_at = NOW() WHERE id = $1`,
            [submissionId]
          ),
          error => error.code === '23514'
        );
        await client.query('ROLLBACK TO SAVEPOINT reject_unprobed_l3_submission');
        await client.query('RELEASE SAVEPOINT reject_unprobed_l3_submission');
        await client.query(
          `UPDATE identity_l3_submission_trigger_test
           SET media_duration_seconds = 42, status = 'pending_review',
               processing_completed_at = NOW() WHERE id = $1`,
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

        const staleReviewId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
        await client.query(
          'INSERT INTO identity_l3_submission_trigger_test (id, user_id, status) VALUES ($1, $2, $3)',
          [staleReviewId, ownerId, 'draft']
        );
        await client.query(
          "UPDATE identity_l3_submission_trigger_test SET status = 'upload_authorized' WHERE id = $1",
          [staleReviewId]
        );
        await client.query(
          `UPDATE identity_l3_submission_trigger_test
           SET status = 'uploaded', storage_object_key = 'private/l3/stale-review',
               media_sha256 = repeat('d', 64), media_mime_type = 'video/mp4',
               media_size_bytes = 1024, uploaded_at = NOW()
           WHERE id = $1`,
          [staleReviewId]
        );
        await client.query(
          "UPDATE identity_l3_submission_trigger_test SET status = 'processing' WHERE id = $1",
          [staleReviewId]
        );
        await client.query(
          `UPDATE identity_l3_submission_trigger_test
           SET media_duration_seconds = 42, status = 'pending_review',
               processing_completed_at = NOW() WHERE id = $1`,
          [staleReviewId]
        );
        await client.query(
          "UPDATE identity_l3_submission_trigger_test SET status = 'expired' WHERE id = $1",
          [staleReviewId]
        );
        const staleReview = await client.query(
          'SELECT status FROM identity_l3_submission_trigger_test WHERE id = $1',
          [staleReviewId]
        );
        assert.equal(staleReview.rows[0].status, 'expired',
          'the 30-day retention worker must be allowed to expire pending-review submissions');

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
