import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

test('financial and moderation evidence is immutable and checkout rollovers are archived', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const categoryConstraint = await client.query(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conname = 'user_reports_category_check'
         AND conrelid = 'user_reports'::regclass`
    );
    assert.equal(categoryConstraint.rowCount, 1);
    for (const category of [
      'spam', 'fake_profile', 'harassment', 'safety',
      'children_misrepresentation', 'duplicate_profile', 'other'
    ]) {
      assert.ok(categoryConstraint.rows[0].definition.includes(category),
        `report category ${category} must be accepted by the DB constraint`);
    }

    const reportFunction = await client.query(
      `SELECT pg_get_functiondef('guard_user_report_evidence()'::regprocedure) AS definition`
    );
    assert.match(reportFunction.rows[0].definition, /NEW\.details IS DISTINCT FROM OLD\.details/);
    const auditFunction = await client.query(
      `SELECT pg_get_functiondef('prevent_moderation_audit_mutation()'::regprocedure) AS definition`
    );
    assert.match(auditFunction.rows[0].definition, /moderator_id/);
    const webhookFunction = await client.query(
      `SELECT pg_get_functiondef('prevent_paddle_webhook_event_mutation()'::regprocedure) AS definition`
    );
    assert.match(webhookFunction.rows[0].definition, /deduplication evidence is immutable/);

    await client.query('BEGIN');
    try {
      await client.query(`
        CREATE TEMP TABLE report_evidence_guard_test (
          id uuid PRIMARY KEY,
          reporter_id uuid NOT NULL,
          reported_user_id uuid NOT NULL,
          category text NOT NULL,
          details text NOT NULL,
          status text NOT NULL,
          created_at timestamptz NOT NULL
        ) ON COMMIT DROP
      `);
      await client.query(`
        CREATE TRIGGER report_evidence_guard_test
        BEFORE UPDATE OR DELETE ON report_evidence_guard_test
        FOR EACH ROW EXECUTE FUNCTION guard_user_report_evidence()
      `);
      const reportId = randomUUID();
      await client.query(
        `INSERT INTO report_evidence_guard_test
         VALUES ($1, $2, $3, 'children_misrepresentation', 'submitted evidence', 'open', statement_timestamp())`,
        [reportId, randomUUID(), randomUUID()]
      );
      await client.query('SAVEPOINT report_content_immutable');
      let reportContentError;
      try {
        await client.query(
          'UPDATE report_evidence_guard_test SET details = $2 WHERE id = $1',
          [reportId, 'rewritten evidence']
        );
      } catch (error) { reportContentError = error; }
      assert.equal(reportContentError?.code, '55000');
      await client.query('ROLLBACK TO SAVEPOINT report_content_immutable');
      await client.query('RELEASE SAVEPOINT report_content_immutable');

      await client.query(
        "UPDATE report_evidence_guard_test SET status = 'resolved' WHERE id = $1",
        [reportId]
      );
      await client.query('SAVEPOINT report_status_terminal');
      let reopenError;
      try {
        await client.query(
          "UPDATE report_evidence_guard_test SET status = 'open' WHERE id = $1",
          [reportId]
        );
      } catch (error) { reopenError = error; }
      assert.equal(reopenError?.code, '23514');
      await client.query('ROLLBACK TO SAVEPOINT report_status_terminal');
      await client.query('RELEASE SAVEPOINT report_status_terminal');

      await client.query(`
        CREATE TEMP TABLE audit_append_only_test (
          moderator_id uuid, action text, target_type text, target_id text,
          reason text, details jsonb, created_at timestamptz
        ) ON COMMIT DROP
      `);
      await client.query(`
        CREATE TRIGGER audit_append_only_test
        BEFORE UPDATE OR DELETE ON audit_append_only_test
        FOR EACH ROW EXECUTE FUNCTION prevent_moderation_audit_mutation()
      `);
      await client.query(
        "INSERT INTO audit_append_only_test VALUES (NULL, 'review', 'user_report', 'report-1', NULL, '{}'::jsonb, statement_timestamp())"
      );
      await client.query('SAVEPOINT audit_no_update');
      let auditUpdateError;
      try { await client.query("UPDATE audit_append_only_test SET reason = 'rewritten'"); }
      catch (error) { auditUpdateError = error; }
      assert.equal(auditUpdateError?.code, '55000');
      await client.query('ROLLBACK TO SAVEPOINT audit_no_update');
      await client.query('RELEASE SAVEPOINT audit_no_update');

      await client.query(`
        CREATE TEMP TABLE webhook_append_only_test (
          event_id text, event_type text, processed_at timestamptz
        ) ON COMMIT DROP
      `);
      await client.query(`
        CREATE TRIGGER webhook_append_only_test
        BEFORE UPDATE OR DELETE ON webhook_append_only_test
        FOR EACH ROW EXECUTE FUNCTION prevent_paddle_webhook_event_mutation()
      `);
      await client.query(
        "INSERT INTO webhook_append_only_test VALUES ('evt_test_immutable', 'transaction.completed', statement_timestamp())"
      );
      await client.query('SAVEPOINT webhook_no_delete');
      let webhookDeleteError;
      try { await client.query("DELETE FROM webhook_append_only_test"); }
      catch (error) { webhookDeleteError = error; }
      assert.equal(webhookDeleteError?.code, '55000');
      await client.query('ROLLBACK TO SAVEPOINT webhook_no_delete');
      await client.query('RELEASE SAVEPOINT webhook_no_delete');

      const userId = randomUUID();
      await client.query(
        "INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, 'test-only-hash', 'active')",
        [userId, `paddle-history-${userId}@example.invalid`]
      );
      const firstAttemptId = randomUUID();
      const secondAttemptId = randomUUID();
      await client.query(
        `INSERT INTO paddle_checkout_attempts
         (user_id, attempt_id, transaction_id, plan, status, created_at, updated_at)
         VALUES ($1, $2, 'txn_historyold123', '1month', 'canceled',
                 statement_timestamp() - interval '1 minute', statement_timestamp() - interval '30 seconds')`,
        [userId, firstAttemptId]
      );
      await client.query('SAVEPOINT current_checkout_attempt_immutable');
      let currentAttemptDeleteError;
      try {
        await client.query('DELETE FROM paddle_checkout_attempts WHERE user_id = $1', [userId]);
      } catch (error) { currentAttemptDeleteError = error; }
      assert.equal(currentAttemptDeleteError?.code, '55000');
      await client.query('ROLLBACK TO SAVEPOINT current_checkout_attempt_immutable');
      await client.query('RELEASE SAVEPOINT current_checkout_attempt_immutable');
      await client.query(
        `UPDATE paddle_checkout_attempts
         SET attempt_id = $2, transaction_id = NULL, plan = '3months',
             status = 'creating', created_at = statement_timestamp(), updated_at = statement_timestamp()
         WHERE user_id = $1`,
        [userId, secondAttemptId]
      );
      const history = await client.query(
        `SELECT user_id, attempt_id, transaction_id, plan, status
         FROM paddle_checkout_attempt_history WHERE user_id = $1`,
        [userId]
      );
      assert.deepEqual(history.rows, [{
        user_id: userId,
        attempt_id: firstAttemptId,
        transaction_id: 'txn_historyold123',
        plan: '1month',
        status: 'canceled'
      }], 'the terminal attempt must be archived atomically before current-row reuse');

      await client.query('SAVEPOINT history_immutable');
      let historyUpdateError;
      try {
        await client.query(
          "UPDATE paddle_checkout_attempt_history SET status = 'linked' WHERE user_id = $1",
          [userId]
        );
      } catch (error) { historyUpdateError = error; }
      assert.equal(historyUpdateError?.code, '55000');
      await client.query('ROLLBACK TO SAVEPOINT history_immutable');
      await client.query('RELEASE SAVEPOINT history_immutable');

      const checkoutFk = await client.query(
        `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
         WHERE conname = 'paddle_checkout_attempts_user_id_fkey'
           AND conrelid = 'paddle_checkout_attempts'::regclass`
      );
      assert.match(checkoutFk.rows[0].definition, /ON DELETE RESTRICT/);
      const reportFks = await client.query(
        `SELECT conname, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
         WHERE conrelid = 'user_reports'::regclass
           AND conname IN ('user_reports_reporter_id_fkey', 'user_reports_reported_user_id_fkey')`
      );
      assert.equal(reportFks.rowCount, 2);
      assert.ok(reportFks.rows.every(row => /ON DELETE RESTRICT/.test(row.definition)));

      // Exercise the actual report FKs: neither reporter nor target can be
      // physically deleted while the submitted evidence still references them.
      const reporterId = randomUUID();
      const reportedId = randomUUID();
      await client.query(
        "INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, 'test-only-hash', 'active'), ($3, $4, 'test-only-hash', 'active')",
        [reporterId, `reporter-${reporterId}@example.invalid`, reportedId, `reported-${reportedId}@example.invalid`]
      );
      const realReport = await client.query(
        "INSERT INTO user_reports (reporter_id, reported_user_id, category, details) VALUES ($1, $2, 'safety', 'immutable evidence') RETURNING id",
        [reporterId, reportedId]
      );
      await client.query('SAVEPOINT report_reporter_restrict');
      let reporterDeleteError;
      try { await client.query('DELETE FROM users WHERE id = $1', [reporterId]); }
      catch (error) { reporterDeleteError = error; }
      assert.equal(reporterDeleteError?.code, '23503');
      await client.query('ROLLBACK TO SAVEPOINT report_reporter_restrict');
      await client.query('RELEASE SAVEPOINT report_reporter_restrict');

      await client.query('SAVEPOINT report_target_restrict');
      let targetDeleteError;
      try { await client.query('DELETE FROM users WHERE id = $1', [reportedId]); }
      catch (error) { targetDeleteError = error; }
      assert.equal(targetDeleteError?.code, '23503');
      await client.query('ROLLBACK TO SAVEPOINT report_target_restrict');
      await client.query('RELEASE SAVEPOINT report_target_restrict');
      const preservedReport = await client.query(
        'SELECT id FROM user_reports WHERE id = $1',
        [realReport.rows[0].id]
      );
      assert.equal(preservedReport.rowCount, 1);
      await client.query('SAVEPOINT real_report_content_immutable');
      let realReportMutationError;
      try {
        await client.query('UPDATE user_reports SET details = $2 WHERE id = $1',
          [realReport.rows[0].id, 'rewritten evidence']);
      } catch (error) { realReportMutationError = error; }
      assert.equal(realReportMutationError?.code, '55000');
      await client.query('ROLLBACK TO SAVEPOINT real_report_content_immutable');
      await client.query('RELEASE SAVEPOINT real_report_content_immutable');
      await client.query(
        "UPDATE user_reports SET status = 'reviewing' WHERE id = $1",
        [realReport.rows[0].id]
      );
      await client.query(
        "UPDATE user_reports SET status = 'resolved' WHERE id = $1",
        [realReport.rows[0].id]
      );
      await client.query('SAVEPOINT real_report_terminal');
      let realReportReopenError;
      try {
        await client.query("UPDATE user_reports SET status = 'open' WHERE id = $1",
          [realReport.rows[0].id]);
      } catch (error) { realReportReopenError = error; }
      assert.equal(realReportReopenError?.code, '23514');
      await client.query('ROLLBACK TO SAVEPOINT real_report_terminal');
      await client.query('RELEASE SAVEPOINT real_report_terminal');

      // The audit append-only guard must permit only the nested FK action that
      // nulls moderator_id when the moderator account is physically removed.
      const moderatorId = randomUUID();
      await client.query(
        "INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, 'test-only-hash', 'active')",
        [moderatorId, `moderator-${moderatorId}@example.invalid`]
      );
      const auditEntry = await client.query(
        "INSERT INTO moderation_audit_log (moderator_id, action, target_type, target_id) VALUES ($1, 'test_action', 'test', 'retention-test') RETURNING id",
        [moderatorId]
      );
      await client.query('DELETE FROM users WHERE id = $1', [moderatorId]);
      const preservedAudit = await client.query(
        'SELECT moderator_id, action FROM moderation_audit_log WHERE id = $1',
        [auditEntry.rows[0].id]
      );
      assert.deepEqual(preservedAudit.rows[0], { moderator_id: null, action: 'test_action' });
      await client.query('SAVEPOINT real_audit_immutable');
      let realAuditMutationError;
      try {
        await client.query("UPDATE moderation_audit_log SET reason = 'rewritten' WHERE id = $1",
          [auditEntry.rows[0].id]);
      } catch (error) { realAuditMutationError = error; }
      assert.equal(realAuditMutationError?.code, '55000');
      await client.query('ROLLBACK TO SAVEPOINT real_audit_immutable');
      await client.query('RELEASE SAVEPOINT real_audit_immutable');

      // Verify the installed webhook trigger itself, not only its function body.
      const webhookEventId = `evt_retention_${randomUUID().replace(/-/g, '')}`;
      await client.query(
        'INSERT INTO paddle_webhook_events (event_id, event_type) VALUES ($1, $2)',
        [webhookEventId, 'transaction.completed']
      );
      await client.query('SAVEPOINT webhook_real_table_immutable');
      let realWebhookDeleteError;
      try { await client.query('DELETE FROM paddle_webhook_events WHERE event_id = $1', [webhookEventId]); }
      catch (error) { realWebhookDeleteError = error; }
      assert.equal(realWebhookDeleteError?.code, '55000');
      await client.query('ROLLBACK TO SAVEPOINT webhook_real_table_immutable');
      await client.query('RELEASE SAVEPOINT webhook_real_table_immutable');
      await client.query('SAVEPOINT webhook_real_update_immutable');
      let realWebhookUpdateError;
      try {
        await client.query('UPDATE paddle_webhook_events SET event_type = $2 WHERE event_id = $1',
          [webhookEventId, 'transaction.canceled']);
      } catch (error) { realWebhookUpdateError = error; }
      assert.equal(realWebhookUpdateError?.code, '55000');
      await client.query('ROLLBACK TO SAVEPOINT webhook_real_update_immutable');
      await client.query('RELEASE SAVEPOINT webhook_real_update_immutable');

      // Both terminal statuses are eligible for rollover and must be archived.
      const linkedUserId = randomUUID();
      await client.query(
        "INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, 'test-only-hash', 'active')",
        [linkedUserId, `linked-history-${linkedUserId}@example.invalid`]
      );
      const linkedAttemptId = randomUUID();
      const replacementAttemptId = randomUUID();
      const linkedTransactionId = `txn_${randomUUID().replace(/-/g, '')}`;
      await client.query(
        `INSERT INTO paddle_checkout_attempts
         (user_id, attempt_id, transaction_id, plan, status, created_at, updated_at)
         VALUES ($1, $2, $3, '3months', 'linked', statement_timestamp(), statement_timestamp())`,
        [linkedUserId, linkedAttemptId, linkedTransactionId]
      );
      await client.query(
        `UPDATE paddle_checkout_attempts
         SET attempt_id = $2, transaction_id = NULL, plan = '1month',
             status = 'creating', created_at = statement_timestamp(), updated_at = statement_timestamp()
         WHERE user_id = $1`,
        [linkedUserId, replacementAttemptId]
      );
      const linkedHistory = await client.query(
        'SELECT attempt_id, transaction_id, plan, status FROM paddle_checkout_attempt_history WHERE user_id = $1',
        [linkedUserId]
      );
      assert.deepEqual(linkedHistory.rows, [{
        attempt_id: linkedAttemptId,
        transaction_id: linkedTransactionId,
        plan: '3months',
        status: 'linked'
      }]);
      const historyFk = await client.query(
        `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
         WHERE conname = 'paddle_checkout_attempt_history_user_id_fkey'
           AND conrelid = 'paddle_checkout_attempt_history'::regclass`
      );
      assert.equal(historyFk.rowCount, 1);
      assert.match(historyFk.rows[0].definition, /ON DELETE RESTRICT/);
      const historyOnlyUserId = randomUUID();
      const historyOnlyAttemptId = randomUUID();
      await client.query(
        "INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, 'test-only-hash', 'active')",
        [historyOnlyUserId, `history-only-${historyOnlyUserId}@example.invalid`]
      );
      await client.query(
        `INSERT INTO paddle_checkout_attempt_history
         (user_id, attempt_id, transaction_id, plan, status, created_at, updated_at)
         VALUES ($1, $2, $3, '1month', 'canceled', statement_timestamp(), statement_timestamp())`,
        [historyOnlyUserId, historyOnlyAttemptId, `txn_${randomUUID().replace(/-/g, '')}`]
      );
      await client.query('SAVEPOINT history_user_restrict');
      let historyUserDeleteError;
      try { await client.query('DELETE FROM users WHERE id = $1', [historyOnlyUserId]); }
      catch (error) { historyUserDeleteError = error; }
      assert.equal(historyUserDeleteError?.code, '23503');
      await client.query('ROLLBACK TO SAVEPOINT history_user_restrict');
      await client.query('RELEASE SAVEPOINT history_user_restrict');
      const adjustmentGuard = await client.query(
        `SELECT pg_get_functiondef('prevent_paddle_adjustment_event_mutation()'::regprocedure) AS definition`
      );
      assert.match(adjustmentGuard.rows[0].definition, /Paddle adjustment evidence is append-only/);
      const adjustmentEventId = `evt_retention_${randomUUID().replace(/-/g, '')}`;
      await client.query(
        `INSERT INTO paddle_adjustment_events
         (event_id, adjustment_id, transaction_id, action, adjustment_type, status, occurred_at)
         VALUES ($1, $2, $3, 'refund', 'full', 'pending_approval', statement_timestamp())`,
        [adjustmentEventId, `adj_${randomUUID().replace(/-/g, '')}`, `txn_${randomUUID().replace(/-/g, '')}`]
      );
      const adjustmentCase = await client.query(
        `INSERT INTO paddle_adjustment_reconciliation_cases
         (event_id, reason_code)
         VALUES ($1, 'lifetime_transaction_unlinked')
         RETURNING status`,
        [adjustmentEventId]
      );
      assert.deepEqual(adjustmentCase.rows, [{ status: 'open' }]);
      await client.query('SAVEPOINT adjustment_case_resolve');
      await client.query(
        `UPDATE paddle_adjustment_reconciliation_cases
         SET status = 'resolved', resolution_note = 'linked and reconciled',
             resolution_source = 'manual_operator', resolved_by_ref = $2,
             resolved_at = statement_timestamp(), updated_at = statement_timestamp()
         WHERE event_id = $1`,
        [adjustmentEventId, randomUUID()]
      );
      const resolvedAdjustmentCase = await client.query(
        'SELECT status, resolution_note FROM paddle_adjustment_reconciliation_cases WHERE event_id = $1',
        [adjustmentEventId]
      );
      assert.deepEqual(resolvedAdjustmentCase.rows, [{
        status: 'resolved', resolution_note: 'linked and reconciled'
      }]);
      await client.query('SAVEPOINT adjustment_case_immutable');
      let adjustmentCaseMutationError;
      try {
        await client.query(
          `UPDATE paddle_adjustment_reconciliation_cases
           SET reason_code = 'lifetime_entitlement_missing' WHERE event_id = $1`,
          [adjustmentEventId]
        );
      } catch (error) { adjustmentCaseMutationError = error; }
      assert.equal(adjustmentCaseMutationError?.code, '55000');
      await client.query('ROLLBACK TO SAVEPOINT adjustment_case_immutable');
      await client.query('RELEASE SAVEPOINT adjustment_case_immutable');
      await client.query('ROLLBACK TO SAVEPOINT adjustment_case_resolve');
      await client.query('RELEASE SAVEPOINT adjustment_case_resolve');
      await client.query('SAVEPOINT adjustment_event_immutable');
      let adjustmentMutationError;
      try {
        await client.query("UPDATE paddle_adjustment_events SET status = 'approved' WHERE event_id = $1",
          [adjustmentEventId]);
      } catch (error) { adjustmentMutationError = error; }
      assert.equal(adjustmentMutationError?.code, '55000');
      await client.query('ROLLBACK TO SAVEPOINT adjustment_event_immutable');
      await client.query('RELEASE SAVEPOINT adjustment_event_immutable');

      const adjustmentCaseGuard = await client.query(
        `SELECT pg_get_functiondef('guard_paddle_adjustment_reconciliation_case()'::regprocedure) AS definition`
      );
      assert.match(adjustmentCaseGuard.rows[0].definition, /reconciliation evidence is immutable/);
      const adjustmentCaseColumns = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'paddle_adjustment_reconciliation_cases'
           AND column_name IN ('event_id', 'reason_code', 'status', 'resolution_source', 'resolved_by_ref')`
      );
      assert.deepEqual(adjustmentCaseColumns.rows.map(row => row.column_name).sort(),
        ['event_id', 'reason_code', 'resolution_source', 'resolved_by_ref', 'status']);

      const accessFks = await client.query(
        `SELECT conname, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
         WHERE conrelid = 'identity_l3_media_access_events'::regclass
           AND conname IN (
             'identity_l3_media_access_events_submission_id_fkey',
             'identity_l3_media_access_events_moderator_user_id_fkey'
           )`
      );
      assert.equal(accessFks.rowCount, 2);
      assert.ok(accessFks.rows.every(row => /ON DELETE SET NULL/.test(row.definition)));
      const accessSnapshots = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'identity_l3_media_access_events'
           AND column_name IN ('submission_ref', 'moderator_ref')`
      );
      assert.deepEqual(accessSnapshots.rows.map(row => row.column_name).sort(), ['moderator_ref', 'submission_ref']);

      const giftEventGuard = await client.query(
        `SELECT pg_get_functiondef('prevent_gift_delivery_order_event_mutation()'::regprocedure) AS definition`
      );
      assert.match(giftEventGuard.rows[0].definition, /gift delivery order events are append-only/);
      const giftOrderDeleteGuard = await client.query(
        `SELECT pg_get_functiondef('prevent_gift_delivery_order_delete()'::regprocedure) AS definition`
      );
      assert.match(giftOrderDeleteGuard.rows[0].definition, /retained as financial and safety evidence/);
      const giftTaskDeleteGuard = await client.query(
        `SELECT pg_get_functiondef('prevent_gift_payment_reconciliation_task_delete()'::regprocedure) AS definition`
      );
      assert.match(giftTaskDeleteGuard.rows[0].definition, /reconciliation evidence cannot be deleted/);
      const lifetimeIdentityGuard = await client.query(
        `SELECT pg_get_functiondef('guard_paddle_lifetime_entitlement_identity()'::regprocedure) AS definition`
      );
      assert.match(lifetimeIdentityGuard.rows[0].definition, /transaction ownership is immutable/);
      const giftActorSnapshot = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'gift_delivery_order_events' AND column_name = 'actor_ref'`
      );
      assert.equal(giftActorSnapshot.rowCount, 1);

      await client.query(`
        CREATE TEMP TABLE gift_order_event_guard_test (
          actor_user_id uuid, actor_ref uuid, event_type text
        ) ON COMMIT DROP
      `);
      await client.query(`
        CREATE TRIGGER gift_order_event_guard_test
        BEFORE UPDATE OR DELETE ON gift_order_event_guard_test
        FOR EACH ROW EXECUTE FUNCTION prevent_gift_delivery_order_event_mutation()
      `);
      await client.query(
        'INSERT INTO gift_order_event_guard_test VALUES ($1, $1, $2)',
        [randomUUID(), 'request_created']
      );
      await client.query('SAVEPOINT gift_event_append_only');
      let giftEventUpdateError;
      try {
        await client.query("UPDATE gift_order_event_guard_test SET event_type = 'rewritten'");
      } catch (error) { giftEventUpdateError = error; }
      assert.equal(giftEventUpdateError?.code, '55000');
      await client.query('ROLLBACK TO SAVEPOINT gift_event_append_only');
      await client.query('RELEASE SAVEPOINT gift_event_append_only');

      await client.query(`
        CREATE TEMP TABLE gift_order_facts_guard_test (
          id uuid, public_reference text, match_id uuid, sender_id uuid, recipient_id uuid,
          product_name_snapshot text, product_category text, total_minor_units bigint,
          currency char(3), idempotency_key text, created_at timestamptz, expires_at timestamptz,
          catalog_item_id uuid
        ) ON COMMIT DROP
      `);
      await client.query(`
        CREATE TRIGGER gift_order_facts_guard_test
        BEFORE UPDATE ON gift_order_facts_guard_test
        FOR EACH ROW EXECUTE FUNCTION guard_gift_delivery_order_immutable_facts()
      `);
      await client.query(
        `INSERT INTO gift_order_facts_guard_test
         VALUES ($1, 'gift_ref', $2, $3, $4, 'snapshot', 'chocolate', 1000,
                 'USD', 'idempotency', statement_timestamp(), statement_timestamp(), NULL)`,
        [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
      );
      await client.query('SAVEPOINT gift_order_facts_immutable');
      let giftOrderFactError;
      try {
        await client.query('UPDATE gift_order_facts_guard_test SET total_minor_units = 1');
      } catch (error) { giftOrderFactError = error; }
      assert.equal(giftOrderFactError?.code, '55000');
      await client.query('ROLLBACK TO SAVEPOINT gift_order_facts_immutable');
      await client.query('RELEASE SAVEPOINT gift_order_facts_immutable');

      await client.query(`
        CREATE TEMP TABLE evidence_truncate_guard_test (id integer) ON COMMIT DROP
      `);
      await client.query(`
        CREATE TRIGGER evidence_truncate_guard_test
        BEFORE TRUNCATE ON evidence_truncate_guard_test
        FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate()
      `);
      await client.query('INSERT INTO evidence_truncate_guard_test VALUES (1)');
      await client.query('SAVEPOINT evidence_truncate_blocked');
      let truncateError;
      try { await client.query('TRUNCATE evidence_truncate_guard_test'); }
      catch (error) { truncateError = error; }
      assert.equal(truncateError?.code, '55000');
      await client.query('ROLLBACK TO SAVEPOINT evidence_truncate_blocked');
      await client.query('RELEASE SAVEPOINT evidence_truncate_blocked');

      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  } finally {
    client.release();
    await pool.end();
  }
});
