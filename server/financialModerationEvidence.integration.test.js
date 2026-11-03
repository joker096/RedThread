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
