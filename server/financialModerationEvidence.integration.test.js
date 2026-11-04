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
    const moderationActorSnapshotTrigger = await client.query(
      `SELECT tgname FROM pg_trigger
       WHERE tgrelid = 'moderation_audit_log'::regclass
         AND tgname = 'moderation_audit_log_snapshot_moderator'
         AND NOT tgisinternal`
    );
    assert.equal(moderationActorSnapshotTrigger.rowCount, 1);

    const webhookFunction = await client.query(
      `SELECT pg_get_functiondef('prevent_paddle_webhook_event_mutation()'::regprocedure) AS definition`
    );
    assert.match(webhookFunction.rows[0].definition, /deduplication evidence is immutable/);

    await client.query('BEGIN');
    try {
      const lifetimeReasonConstraint = await client.query(
        `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
         WHERE conname = 'paddle_lifetime_entitlements_status_reason_check'
           AND conrelid = 'paddle_lifetime_entitlements'::regclass`
      );
      assert.equal(lifetimeReasonConstraint.rowCount, 1);
      assert.match(lifetimeReasonConstraint.rows[0].definition, /paddle_full_refund/);
      assert.match(lifetimeReasonConstraint.rows[0].definition, /paddle_chargeback/);

      const lifetimeReasonUserId = randomUUID();
      await client.query(
        "INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, 'test-only-hash', 'active')",
        [lifetimeReasonUserId, `lifetime-reason-${lifetimeReasonUserId}@example.invalid`]
      );
      const missingReasonTransactionId = `txn_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
      await client.query('SAVEPOINT revoked_lifetime_requires_reason');
      let missingLifetimeReasonError;
      try {
        await client.query(
          `INSERT INTO paddle_lifetime_entitlements (transaction_id, user_id, status, revoke_reason)
           VALUES ($1, $2, 'revoked', NULL)`,
          [missingReasonTransactionId, lifetimeReasonUserId]
        );
      } catch (error) { missingLifetimeReasonError = error; }
      assert.equal(missingLifetimeReasonError?.code, '23514',
        'a revoked lifetime entitlement must never be stored without its provider-backed reason');
      await client.query('ROLLBACK TO SAVEPOINT revoked_lifetime_requires_reason');
      await client.query('RELEASE SAVEPOINT revoked_lifetime_requires_reason');

      const invalidReasonTransactionId = `txn_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
      await client.query('SAVEPOINT revoked_lifetime_reason_allowlist');
      let invalidLifetimeReasonError;
      try {
        await client.query(
          `INSERT INTO paddle_lifetime_entitlements (transaction_id, user_id, status, revoke_reason)
           VALUES ($1, $2, 'revoked', 'manual_override')`,
          [invalidReasonTransactionId, lifetimeReasonUserId]
        );
      } catch (error) { invalidLifetimeReasonError = error; }
      assert.equal(invalidLifetimeReasonError?.code, '23514',
        'only verified Paddle refund and chargeback reasons may revoke lifetime provenance');
      await client.query('ROLLBACK TO SAVEPOINT revoked_lifetime_reason_allowlist');
      await client.query('RELEASE SAVEPOINT revoked_lifetime_reason_allowlist');

      const lifetimeTransactionId = `txn_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
      const lifetimeAttemptId = randomUUID();
      await client.query(
        `INSERT INTO paddle_checkout_attempts
         (user_id, attempt_id, transaction_id, plan, status, created_at, updated_at)
         VALUES ($1, $2, NULL, 'lifetime', 'creating', statement_timestamp(), statement_timestamp())`,
        [lifetimeReasonUserId, lifetimeAttemptId]
      );
      await client.query(
        `UPDATE paddle_checkout_attempts
         SET transaction_id = $2, status = 'completed', updated_at = statement_timestamp()
         WHERE user_id = $1 AND attempt_id = $3`,
        [lifetimeReasonUserId, lifetimeTransactionId, lifetimeAttemptId]
      );

      const lifetimeTransactionEventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
      await client.query(
        "INSERT INTO paddle_webhook_events (event_id, event_type) VALUES ($1, 'transaction.completed')",
        [lifetimeTransactionEventId]
      );
      await client.query(
        `INSERT INTO paddle_transaction_events
         (event_id, transaction_id, user_id, plan, status, occurred_at)
         VALUES ($1, $2, $3, 'lifetime', 'completed', statement_timestamp())`,
        [lifetimeTransactionEventId, lifetimeTransactionId, lifetimeReasonUserId]
      );
      await client.query(
        `UPDATE paddle_checkout_attempts SET status = 'linked', updated_at = statement_timestamp()
         WHERE user_id = $1 AND attempt_id = $2`,
        [lifetimeReasonUserId, lifetimeAttemptId]
      );
      await client.query('SET CONSTRAINTS paddle_checkout_attempts_linked_transaction_evidence_guard IMMEDIATE');
      await client.query('SET CONSTRAINTS paddle_checkout_attempts_linked_transaction_evidence_guard DEFERRED');

      const unlinkedEntitlementUserId = randomUUID();
      const unlinkedTransactionId = `txn_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
      await client.query(
        "INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, 'test-only-hash', 'active')",
        [unlinkedEntitlementUserId, `unlinked-entitlement-${unlinkedEntitlementUserId}@example.invalid`]
      );
      await client.query('SAVEPOINT lifetime_entitlement_requires_link');
      await client.query(
        `INSERT INTO paddle_lifetime_entitlements (transaction_id, user_id, status)
         VALUES ($1, $2, 'active')`,
        [unlinkedTransactionId, unlinkedEntitlementUserId]
      );
      let missingLifetimeOwnerError;
      try {
        await client.query('SET CONSTRAINTS paddle_lifetime_entitlements_owner_evidence_guard IMMEDIATE');
      } catch (error) { missingLifetimeOwnerError = error; }
      assert.equal(missingLifetimeOwnerError?.code, '23514',
        'a lifetime entitlement must not be created without one linked lifetime checkout owner');
      await client.query('ROLLBACK TO SAVEPOINT lifetime_entitlement_requires_link');
      await client.query('RELEASE SAVEPOINT lifetime_entitlement_requires_link');
      await client.query('SET CONSTRAINTS paddle_lifetime_entitlements_owner_evidence_guard DEFERRED');

      await client.query(
        `INSERT INTO paddle_lifetime_entitlements (transaction_id, user_id, status, revoke_reason)
         VALUES ($1, $2, 'revoked', 'paddle_full_refund')`,
        [lifetimeTransactionId, lifetimeReasonUserId]
      );
      await client.query('SET CONSTRAINTS paddle_lifetime_entitlements_owner_evidence_guard IMMEDIATE');

      const otherLifetimeUserId = randomUUID();
      await client.query(
        "INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, 'test-only-hash', 'active')",
        [otherLifetimeUserId, `other-lifetime-${otherLifetimeUserId}@example.invalid`]
      );
      await client.query('SAVEPOINT lifetime_entitlement_identity_immutable');
      let lifetimeOwnerMutationError;
      try {
        await client.query(
          'UPDATE paddle_lifetime_entitlements SET user_id = $2 WHERE transaction_id = $1',
          [lifetimeTransactionId, otherLifetimeUserId]
        );
      } catch (error) { lifetimeOwnerMutationError = error; }
      assert.equal(lifetimeOwnerMutationError?.code, '55000',
        'a lifetime transaction cannot be reassigned to another Vow account');
      await client.query('ROLLBACK TO SAVEPOINT lifetime_entitlement_identity_immutable');
      await client.query('RELEASE SAVEPOINT lifetime_entitlement_identity_immutable');

      await client.query('SAVEPOINT lifetime_entitlement_delete_blocked');
      let lifetimeEntitlementDeleteError;
      try {
        await client.query('DELETE FROM paddle_lifetime_entitlements WHERE transaction_id = $1',
          [lifetimeTransactionId]);
      } catch (error) { lifetimeEntitlementDeleteError = error; }
      assert.equal(lifetimeEntitlementDeleteError?.code, '55000',
        'lifetime transaction provenance must not be deleted');
      await client.query('ROLLBACK TO SAVEPOINT lifetime_entitlement_delete_blocked');
      await client.query('RELEASE SAVEPOINT lifetime_entitlement_delete_blocked');

      await client.query('SAVEPOINT lifetime_entitlement_truncate_blocked');
      let lifetimeEntitlementTruncateError;
      try { await client.query('TRUNCATE paddle_lifetime_entitlements'); }
      catch (error) { lifetimeEntitlementTruncateError = error; }
      assert.equal(lifetimeEntitlementTruncateError?.code, '55000',
        'lifetime transaction provenance must not be truncated');
      await client.query('ROLLBACK TO SAVEPOINT lifetime_entitlement_truncate_blocked');
      await client.query('RELEASE SAVEPOINT lifetime_entitlement_truncate_blocked');

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
          moderator_id uuid, moderator_ref uuid, action text, target_type text, target_id text,
          reason text, details jsonb, created_at timestamptz
        ) ON COMMIT DROP
      `);
      await client.query(`
        CREATE TRIGGER audit_actor_snapshot_test
        BEFORE INSERT ON audit_append_only_test
        FOR EACH ROW EXECUTE FUNCTION snapshot_moderation_audit_moderator()
      `);
      await client.query(`
        CREATE TRIGGER audit_append_only_test
        BEFORE UPDATE OR DELETE ON audit_append_only_test
        FOR EACH ROW EXECUTE FUNCTION prevent_moderation_audit_mutation()
      `);
      await client.query(
        "INSERT INTO audit_append_only_test VALUES ($1, NULL, 'review', 'user_report', 'report-1', NULL, '{}'::jsonb, statement_timestamp())",
        [randomUUID()]
      );
      const auditActorSnapshot = await client.query(
        'SELECT moderator_id, moderator_ref FROM audit_append_only_test'
      );
      assert.equal(auditActorSnapshot.rows[0].moderator_ref, auditActorSnapshot.rows[0].moderator_id,
        'new moderation audit rows must snapshot the moderator UUID');
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

      const forgedAttemptUserId = randomUUID();
      await client.query(
        "INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, 'test-only-hash', 'active')",
        [forgedAttemptUserId, `forged-attempt-${forgedAttemptUserId}@example.invalid`]
      );
      await client.query('SAVEPOINT checkout_attempt_initial_state_guard');
      let forgedInitialCheckoutStateError;
      try {
        await client.query(
          `INSERT INTO paddle_checkout_attempts
           (user_id, attempt_id, transaction_id, plan, status, created_at, updated_at)
           VALUES ($1, $2, $3, 'lifetime', 'linked', statement_timestamp(), statement_timestamp())`,
          [forgedAttemptUserId, randomUUID(), `txn_${randomUUID().replace(/-/g, '').slice(0, 26)}`]
        );
      } catch (error) { forgedInitialCheckoutStateError = error; }
      assert.equal(forgedInitialCheckoutStateError?.code, '23514',
        'a caller cannot insert a checkout attempt directly into a provider-linked terminal state');
      await client.query('ROLLBACK TO SAVEPOINT checkout_attempt_initial_state_guard');
      await client.query('RELEASE SAVEPOINT checkout_attempt_initial_state_guard');


      const unverifiedLinkedUserId = randomUUID();
      const unverifiedLinkedAttemptId = randomUUID();
      const unverifiedLinkedTransactionId = `txn_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
      await client.query(
        "INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, 'test-only-hash', 'active')",
        [unverifiedLinkedUserId, `unverified-link-${unverifiedLinkedUserId}@example.invalid`]
      );
      await client.query(
        `INSERT INTO paddle_checkout_attempts
         (user_id, attempt_id, transaction_id, plan, status, created_at, updated_at)
         VALUES ($1, $2, NULL, 'lifetime', 'creating', statement_timestamp(), statement_timestamp())`,
        [unverifiedLinkedUserId, unverifiedLinkedAttemptId]
      );
      await client.query(
        `UPDATE paddle_checkout_attempts
         SET transaction_id = $3, status = 'completed', updated_at = statement_timestamp()
         WHERE user_id = $1 AND attempt_id = $2`,
        [unverifiedLinkedUserId, unverifiedLinkedAttemptId, unverifiedLinkedTransactionId]
      );
      await client.query('SAVEPOINT checkout_link_without_provider_event');
      await client.query(
        `UPDATE paddle_checkout_attempts SET status = 'linked', updated_at = statement_timestamp()
         WHERE user_id = $1 AND attempt_id = $2`,
        [unverifiedLinkedUserId, unverifiedLinkedAttemptId]
      );
      let missingLinkedProviderEventError;
      try {
        await client.query('SET CONSTRAINTS paddle_checkout_attempts_linked_transaction_evidence_guard IMMEDIATE');
      } catch (error) { missingLinkedProviderEventError = error; }
      assert.equal(missingLinkedProviderEventError?.code, '23514',
        'a completed checkout cannot become linked without its matching transaction.completed webhook evidence');
      await client.query('ROLLBACK TO SAVEPOINT checkout_link_without_provider_event');
      await client.query('RELEASE SAVEPOINT checkout_link_without_provider_event');
      await client.query('SET CONSTRAINTS paddle_checkout_attempts_linked_transaction_evidence_guard DEFERRED');

      const userId = randomUUID();
      await client.query(
        "INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, 'test-only-hash', 'active')",
        [userId, `paddle-history-${userId}@example.invalid`]
      );
      const firstAttemptId = randomUUID();
      const secondAttemptId = randomUUID();
      const canceledTransactionId = `txn_${randomUUID().replace(/-/g, '').slice(0, 26)}`;

      await client.query('SAVEPOINT checkout_history_direct_insert_blocked');
      let directCheckoutHistoryInsertError;
      try {
        await client.query(
          `INSERT INTO paddle_checkout_attempt_history
           (user_id, attempt_id, transaction_id, plan, status, created_at, updated_at)
           VALUES ($1, $2, $3, '1month', 'linked', statement_timestamp(), statement_timestamp())`,
          [userId, randomUUID(), `txn_${randomUUID().replace(/-/g, '').slice(0, 26)}`]
        );
      } catch (error) { directCheckoutHistoryInsertError = error; }
      assert.equal(directCheckoutHistoryInsertError?.code, '55000',
        'checkout history may only be written by the nested terminal-rollover trigger');
      await client.query('ROLLBACK TO SAVEPOINT checkout_history_direct_insert_blocked');
      await client.query('RELEASE SAVEPOINT checkout_history_direct_insert_blocked');
      await client.query(
        `INSERT INTO paddle_checkout_attempts
         (user_id, attempt_id, transaction_id, plan, status, created_at, updated_at)
         VALUES ($1, $2, NULL, '1month', 'creating',
                 statement_timestamp() - interval '1 minute', statement_timestamp() - interval '30 seconds')`,
        [userId, firstAttemptId]
      );
      await client.query(
        `UPDATE paddle_checkout_attempts
         SET transaction_id = $3, status = 'canceled',
             updated_at = statement_timestamp()
         WHERE user_id = $1 AND attempt_id = $2`,
        [userId, firstAttemptId, canceledTransactionId]
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
        transaction_id: canceledTransactionId,
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

      const thirdAttemptId = randomUUID();
      const completedHistoryTransactionId = `txn_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
      await client.query(
        `UPDATE paddle_checkout_attempts
         SET transaction_id = $3, status = 'pending', updated_at = statement_timestamp()
         WHERE user_id = $1 AND attempt_id = $2`,
        [userId, secondAttemptId, completedHistoryTransactionId]
      );
      await client.query(
        `UPDATE paddle_checkout_attempts
         SET status = 'completed', updated_at = statement_timestamp()
         WHERE user_id = $1 AND attempt_id = $2`,
        [userId, secondAttemptId]
      );
      await client.query(
        `UPDATE paddle_checkout_attempts
         SET attempt_id = $2, transaction_id = NULL, plan = '1month',
             status = 'creating', created_at = statement_timestamp(), updated_at = statement_timestamp()
         WHERE user_id = $1`,
        [userId, thirdAttemptId]
      );
      const completedHistory = await client.query(
        `SELECT user_id, attempt_id, transaction_id, plan, status
         FROM paddle_checkout_attempt_history
         WHERE user_id = $1 AND transaction_id = $2`,
        [userId, completedHistoryTransactionId]
      );
      assert.deepEqual(completedHistory.rows, [{
        user_id: userId,
        attempt_id: secondAttemptId,
        transaction_id: completedHistoryTransactionId,
        plan: '3months',
        status: 'completed'
      }], 'completed recurring transactions must also be archived before checkout pointer reuse');

      const linkedTransitionUserId = randomUUID();
      const linkedTransitionAttemptId = randomUUID();
      const linkedTransitionTransactionId = `txn_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
      const linkedTransitionEventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
      await client.query(
        "INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, 'test-only-hash', 'active')",
        [linkedTransitionUserId, `completed-linked-${linkedTransitionUserId}@example.invalid`]
      );
      await client.query(
        `INSERT INTO paddle_checkout_attempts
         (user_id, attempt_id, transaction_id, plan, status, created_at, updated_at)
         VALUES ($1, $2, NULL, 'lifetime', 'creating',
                 statement_timestamp(), statement_timestamp())`,
        [linkedTransitionUserId, linkedTransitionAttemptId]
      );
      await client.query(
        `UPDATE paddle_checkout_attempts
         SET transaction_id = $3, status = 'completed', updated_at = statement_timestamp()
         WHERE user_id = $1 AND attempt_id = $2`,
        [linkedTransitionUserId, linkedTransitionAttemptId, linkedTransitionTransactionId]
      );
      await client.query(
        "INSERT INTO paddle_webhook_events (event_id, event_type) VALUES ($1, 'transaction.completed')",
        [linkedTransitionEventId]
      );
      await client.query(
        `INSERT INTO paddle_transaction_events
         (event_id, transaction_id, user_id, plan, status, occurred_at)
         VALUES ($1, $2, $3, 'lifetime', 'completed', statement_timestamp())`,
        [linkedTransitionEventId, linkedTransitionTransactionId, linkedTransitionUserId]
      );
      await client.query(
        `UPDATE paddle_checkout_attempts SET status = 'linked', updated_at = statement_timestamp()
         WHERE user_id = $1 AND attempt_id = $2`,
        [linkedTransitionUserId, linkedTransitionAttemptId]
      );
      await client.query('SET CONSTRAINTS paddle_checkout_attempts_linked_transaction_evidence_guard IMMEDIATE');
      await client.query('SET CONSTRAINTS paddle_checkout_attempts_linked_transaction_evidence_guard DEFERRED');
      const linkedTransition = await client.query(
        'SELECT status, attempt_id, transaction_id, plan FROM paddle_checkout_attempts WHERE user_id = $1',
        [linkedTransitionUserId]
      );
      assert.deepEqual(linkedTransition.rows, [{
        status: 'linked',
        attempt_id: linkedTransitionAttemptId,
        transaction_id: linkedTransitionTransactionId,
        plan: 'lifetime'
      }], 'a provider-completed lifetime attempt must be allowed to finalize as linked without changing identity');

      await client.query('SAVEPOINT linked_attempt_terminal');
      let linkedAttemptReopenError;
      try {
        await client.query(
          "UPDATE paddle_checkout_attempts SET status = 'completed' WHERE user_id = $1",
          [linkedTransitionUserId]
        );
      } catch (error) { linkedAttemptReopenError = error; }
      assert.equal(linkedAttemptReopenError?.code, '23514',
        'a linked attempt remains terminal after the permitted completed-to-linked transition');
      await client.query('ROLLBACK TO SAVEPOINT linked_attempt_terminal');
      await client.query('RELEASE SAVEPOINT linked_attempt_terminal');

      const reconciliationTransitionUserId = randomUUID();
      const reconciliationTransitionAttemptId = randomUUID();
      const reconciliationTransactionId = `txn_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
      await client.query(
        "INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, 'test-only-hash', 'active')",
        [reconciliationTransitionUserId, `completed-reconciliation-${reconciliationTransitionUserId}@example.invalid`]
      );
      await client.query(
        `INSERT INTO paddle_checkout_attempts
         (user_id, attempt_id, transaction_id, plan, status, created_at, updated_at)
         VALUES ($1, $2, NULL, 'lifetime', 'creating',
                 statement_timestamp(), statement_timestamp())`,
        [reconciliationTransitionUserId, reconciliationTransitionAttemptId]
      );
      await client.query(
        `UPDATE paddle_checkout_attempts
         SET transaction_id = $3, status = 'completed',
             updated_at = statement_timestamp()
         WHERE user_id = $1 AND attempt_id = $2`,
        [reconciliationTransitionUserId, reconciliationTransitionAttemptId, reconciliationTransactionId]
      );
      await client.query(
        `UPDATE paddle_checkout_attempts SET status = 'reconciliation_required', updated_at = statement_timestamp()
         WHERE user_id = $1 AND attempt_id = $2`,
        [reconciliationTransitionUserId, reconciliationTransitionAttemptId]
      );
      const reconciliationTransition = await client.query(
        'SELECT status, attempt_id, transaction_id FROM paddle_checkout_attempts WHERE user_id = $1',
        [reconciliationTransitionUserId]
      );
      assert.deepEqual(reconciliationTransition.rows, [{
        status: 'reconciliation_required',
        attempt_id: reconciliationTransitionAttemptId,
        transaction_id: reconciliationTransactionId
      }], 'a provider-completed attempt must be able to enter reconciliation without rewriting provider identity');

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
      assert.ok(reportFks.rows.every(row => /ON DELETE SET NULL/.test(row.definition)));

      // Physical account erasure must null live FKs without cascading away the
      // report or losing either opaque identity snapshot.
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
      await client.query('DELETE FROM users WHERE id = $1', [reporterId]);
      const afterReporterErase = await client.query(
        'SELECT reporter_id, reporter_ref, reported_user_id, reported_user_ref FROM user_reports WHERE id = $1',
        [realReport.rows[0].id]
      );
      assert.equal(afterReporterErase.rows[0].reporter_id, null);
      assert.equal(afterReporterErase.rows[0].reporter_ref, reporterId);
      assert.equal(afterReporterErase.rows[0].reported_user_id, reportedId);
      await client.query('DELETE FROM users WHERE id = $1', [reportedId]);
      const preservedReport = await client.query(
        'SELECT id, reporter_id, reporter_ref, reported_user_id, reported_user_ref FROM user_reports WHERE id = $1',
        [realReport.rows[0].id]
      );
      assert.equal(preservedReport.rowCount, 1);
      assert.equal(preservedReport.rows[0].reporter_id, null);
      assert.equal(preservedReport.rows[0].reported_user_id, null);
      assert.equal(preservedReport.rows[0].reporter_ref, reporterId);
      assert.equal(preservedReport.rows[0].reported_user_ref, reportedId);
      await client.query('SAVEPOINT real_report_content_immutable');
      let realReportMutationError;
      try {
        await client.query('UPDATE user_reports SET details = $2 WHERE id = $1',
          [realReport.rows[0].id, 'rewritten evidence']);
      } catch (error) { realReportMutationError = error; }
      assert.equal(realReportMutationError?.code, '55000');
      await client.query('ROLLBACK TO SAVEPOINT real_report_content_immutable');
      await client.query('RELEASE SAVEPOINT real_report_content_immutable');
      await client.query('SAVEPOINT real_report_identity_immutable');
      let reportIdentityMutationError;
      try {
        await client.query('UPDATE user_reports SET reported_user_ref = $2 WHERE id = $1',
          [realReport.rows[0].id, randomUUID()]);
      } catch (error) { reportIdentityMutationError = error; }
      assert.equal(reportIdentityMutationError?.code, '55000');
      await client.query('ROLLBACK TO SAVEPOINT real_report_identity_immutable');
      await client.query('RELEASE SAVEPOINT real_report_identity_immutable');
      await client.query('SAVEPOINT real_report_delete_blocked');
      let reportDeleteError;
      try { await client.query('DELETE FROM user_reports WHERE id = $1', [realReport.rows[0].id]); }
      catch (error) { reportDeleteError = error; }
      assert.equal(reportDeleteError?.code, '55000');
      await client.query('ROLLBACK TO SAVEPOINT real_report_delete_blocked');
      await client.query('RELEASE SAVEPOINT real_report_delete_blocked');
      // Flush deferred FK/constraint-trigger work from the account-erasure
      // checks first; PostgreSQL refuses TRUNCATE while those events are pending,
      // which would otherwise bypass the dedicated no-TRUNCATE trigger assertion.
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      await client.query('SAVEPOINT real_report_truncate_blocked');
      let reportTruncateError;
      try { await client.query('TRUNCATE TABLE user_reports'); }
      catch (error) { reportTruncateError = error; }
      assert.equal(reportTruncateError?.code, '55000');
      await client.query('ROLLBACK TO SAVEPOINT real_report_truncate_blocked');
      await client.query('RELEASE SAVEPOINT real_report_truncate_blocked');
      const reportModeratorId = randomUUID();
      await client.query(
        "INSERT INTO users (id, email, password_hash, role, status) VALUES ($1, $2, 'test-only-hash', 'moderator', 'active')",
        [reportModeratorId, `report-audit-moderator-${reportModeratorId}@example.invalid`]
      );

      // Force the deferred audit constraint at a savepoint: a status change
      // without its same-transaction moderator evidence must be rejected.
      await client.query('SAVEPOINT report_status_without_audit');
      await client.query(
        "UPDATE user_reports SET status = 'reviewing' WHERE id = $1",
        [realReport.rows[0].id]
      );
      let missingReportReviewAuditError;
      try {
        await client.query('SET CONSTRAINTS user_reports_status_audit_guard IMMEDIATE');
      } catch (error) { missingReportReviewAuditError = error; }
      assert.equal(missingReportReviewAuditError?.code, '23514',
        'a report must not enter reviewing without matching moderator audit evidence');
      await client.query('ROLLBACK TO SAVEPOINT report_status_without_audit');
      await client.query('RELEASE SAVEPOINT report_status_without_audit');
      await client.query('SET CONSTRAINTS user_reports_status_audit_guard DEFERRED');

      await client.query(
        "UPDATE user_reports SET status = 'reviewing' WHERE id = $1",
        [realReport.rows[0].id]
      );
      await client.query(
        `INSERT INTO moderation_audit_log
           (moderator_id, action, target_type, target_id, details)
         VALUES ($1, 'review', 'user_report', $2,
                 jsonb_build_object('newStatus', 'reviewing', 'targetUserId', $3::text, 'category', 'safety'))`,
        [reportModeratorId, realReport.rows[0].id, reportedId]
      );
      await client.query(
        "UPDATE user_reports SET status = 'resolved' WHERE id = $1",
        [realReport.rows[0].id]
      );
      await client.query(
        `INSERT INTO moderation_audit_log
           (moderator_id, action, target_type, target_id, details)
         VALUES ($1, 'resolve', 'user_report', $2,
                 jsonb_build_object('newStatus', 'resolved', 'targetUserId', $3::text, 'category', 'safety'))`,
        [reportModeratorId, realReport.rows[0].id, reportedId]
      );
      await client.query('SET CONSTRAINTS user_reports_status_audit_guard IMMEDIATE');
      const reportAuditRows = await client.query(
        `SELECT action, details->>'newStatus' AS new_status, moderator_ref
         FROM moderation_audit_log
         WHERE target_type = 'user_report' AND target_id = $1
         ORDER BY CASE action WHEN 'review' THEN 0 ELSE 1 END, id`,
        [realReport.rows[0].id]
      );
      assert.deepEqual(reportAuditRows.rows.map(row => ({
        action: row.action, status: row.new_status, moderatorRef: row.moderator_ref
      })), [
        { action: 'review', status: 'reviewing', moderatorRef: reportModeratorId },
        { action: 'resolve', status: 'resolved', moderatorRef: reportModeratorId }
      ]);
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
      const linkedTransactionId = `txn_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
      const linkedHistoryEventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
      await client.query(
        `INSERT INTO paddle_checkout_attempts
         (user_id, attempt_id, transaction_id, plan, status, created_at, updated_at)
         VALUES ($1, $2, NULL, '3months', 'creating', statement_timestamp(), statement_timestamp())`,
        [linkedUserId, linkedAttemptId]
      );
      await client.query(
        `UPDATE paddle_checkout_attempts
         SET transaction_id = $2, status = 'completed', updated_at = statement_timestamp()
         WHERE user_id = $1 AND attempt_id = $3`,
        [linkedUserId, linkedTransactionId, linkedAttemptId]
      );
      await client.query(
        "INSERT INTO paddle_webhook_events (event_id, event_type) VALUES ($1, 'transaction.completed')",
        [linkedHistoryEventId]
      );
      await client.query(
        `INSERT INTO paddle_transaction_events
         (event_id, transaction_id, user_id, plan, status, occurred_at)
         VALUES ($1, $2, $3, '3months', 'completed', statement_timestamp())`,
        [linkedHistoryEventId, linkedTransactionId, linkedUserId]
      );
      await client.query(
        `UPDATE paddle_checkout_attempts SET status = 'linked', updated_at = statement_timestamp()
         WHERE user_id = $1 AND attempt_id = $2`,
        [linkedUserId, linkedAttemptId]
      );
      await client.query('SET CONSTRAINTS paddle_checkout_attempts_linked_transaction_evidence_guard IMMEDIATE');
      await client.query('SET CONSTRAINTS paddle_checkout_attempts_linked_transaction_evidence_guard DEFERRED');
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
      const historyOnlyReplacementAttemptId = randomUUID();
      const historyOnlyTransactionId = `txn_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
      await client.query(
        "INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, 'test-only-hash', 'active')",
        [historyOnlyUserId, `history-only-${historyOnlyUserId}@example.invalid`]
      );
      await client.query(
        `INSERT INTO paddle_checkout_attempts
         (user_id, attempt_id, transaction_id, plan, status, created_at, updated_at)
         VALUES ($1, $2, NULL, '1month', 'creating', statement_timestamp(), statement_timestamp())`,
        [historyOnlyUserId, historyOnlyAttemptId]
      );
      await client.query(
        `UPDATE paddle_checkout_attempts
         SET transaction_id = $3, status = 'canceled', updated_at = statement_timestamp()
         WHERE user_id = $1 AND attempt_id = $2`,
        [historyOnlyUserId, historyOnlyAttemptId, historyOnlyTransactionId]
      );
      await client.query(
        `UPDATE paddle_checkout_attempts
         SET attempt_id = $2, transaction_id = NULL, status = 'creating',
             created_at = statement_timestamp(), updated_at = statement_timestamp()
         WHERE user_id = $1`,
        [historyOnlyUserId, historyOnlyReplacementAttemptId]
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
      const adjustmentEventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
      await client.query(
        'INSERT INTO paddle_webhook_events (event_id, event_type) VALUES ($1, $2)',
        [adjustmentEventId, 'adjustment.created']
      );
      await client.query(
        `INSERT INTO paddle_adjustment_events
         (event_id, adjustment_id, transaction_id, action, adjustment_type, status,
          amount_minor_units, currency_code, occurred_at)
         VALUES ($1, $2, $3, 'refund', 'full', 'pending_approval', 500, 'USD', statement_timestamp())`,
        [adjustmentEventId, `adj_${randomUUID().replace(/-/g, '').slice(0, 26)}`, `txn_${randomUUID().replace(/-/g, '').slice(0, 26)}`]
      );
      const adjustmentCase = await client.query(
        `INSERT INTO paddle_adjustment_reconciliation_cases
         (event_id, reason_code)
         VALUES ($1, 'transaction_owner_unlinked')
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
      const adjustmentCaseTriggers = await client.query(
        `SELECT tgname FROM pg_trigger
         WHERE tgrelid = 'paddle_adjustment_reconciliation_cases'::regclass
           AND tgname IN (
             'paddle_adjustment_reconciliation_cases_guard',
             'paddle_adjustment_reconciliation_cases_no_truncate',
             'paddle_adjustment_reconciliation_automatic_link_guard'
           )
           AND NOT tgisinternal`
      );
      assert.equal(adjustmentCaseTriggers.rowCount, 3);
      await client.query('SAVEPOINT adjustment_case_delete_blocked');
      let adjustmentCaseDeleteError;
      try {
        await client.query('DELETE FROM paddle_adjustment_reconciliation_cases WHERE event_id = $1',
          [adjustmentEventId]);
      } catch (error) { adjustmentCaseDeleteError = error; }
      assert.equal(adjustmentCaseDeleteError?.code, '55000');
      await client.query('ROLLBACK TO SAVEPOINT adjustment_case_delete_blocked');
      await client.query('RELEASE SAVEPOINT adjustment_case_delete_blocked');
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

      // The automatic path is not a way to bypass the manual audit requirement:
      // it must be backed by exactly one provider transaction owner. First try
      // closing an unlinked case and force its deferred constraint to execute.
      const autoLinkUserId = randomUUID();
      const autoLinkTransactionId = `txn_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
      const autoLinkAdjustmentEventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
      const autoLinkTransactionEventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
      await client.query(
        "INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, 'test-only-hash', 'active')",
        [autoLinkUserId, `auto-link-${autoLinkUserId}@example.invalid`]
      );
      await client.query(
        "INSERT INTO paddle_webhook_events (event_id, event_type) VALUES ($1, 'adjustment.created')",
        [autoLinkAdjustmentEventId]
      );
      await client.query(
        `INSERT INTO paddle_adjustment_events
         (event_id, adjustment_id, transaction_id, action, adjustment_type, status, occurred_at)
         VALUES ($1, $2, $3, 'refund', 'partial', 'pending_approval', statement_timestamp())`,
        [autoLinkAdjustmentEventId, `adj_${randomUUID().replace(/-/g, '')}`, autoLinkTransactionId]
      );
      await client.query(
        "INSERT INTO paddle_adjustment_reconciliation_cases (event_id, reason_code) VALUES ($1, 'transaction_owner_unlinked')",
        [autoLinkAdjustmentEventId]
      );
      await client.query('SAVEPOINT auto_adjustment_without_link');
      await client.query(
        `UPDATE paddle_adjustment_reconciliation_cases
         SET status = 'resolved', resolution_note = 'claimed automatic link without provider evidence',
             resolution_source = 'automatic_provider_transaction_link', resolved_by_ref = NULL,
             resolved_at = statement_timestamp(), updated_at = statement_timestamp()
         WHERE event_id = $1`,
        [autoLinkAdjustmentEventId]
      );
      let missingAutomaticLinkError;
      try {
        await client.query('SET CONSTRAINTS paddle_adjustment_reconciliation_automatic_link_guard IMMEDIATE');
      } catch (error) { missingAutomaticLinkError = error; }
      assert.equal(missingAutomaticLinkError?.code, '23514',
        'automatic reconciliation must not close a case without a unique provider transaction owner');
      await client.query('ROLLBACK TO SAVEPOINT auto_adjustment_without_link');
      await client.query('RELEASE SAVEPOINT auto_adjustment_without_link');
      await client.query('SET CONSTRAINTS paddle_adjustment_reconciliation_automatic_link_guard DEFERRED');

      await client.query(
        "INSERT INTO paddle_webhook_events (event_id, event_type) VALUES ($1, 'transaction.completed')",
        [autoLinkTransactionEventId]
      );
      await client.query(
        `INSERT INTO paddle_transaction_events
         (event_id, transaction_id, user_id, plan, status, occurred_at)
         VALUES ($1, $2, $3, '1month', 'completed', statement_timestamp())`,
        [autoLinkTransactionEventId, autoLinkTransactionId, autoLinkUserId]
      );
      await client.query(
        `UPDATE paddle_adjustment_reconciliation_cases
         SET status = 'resolved', resolution_note = 'verified against unique completed provider transaction',
             resolution_source = 'automatic_provider_transaction_link', resolved_by_ref = NULL,
             resolved_at = statement_timestamp(), updated_at = statement_timestamp()
         WHERE event_id = $1`,
        [autoLinkAdjustmentEventId]
      );
      await client.query('SET CONSTRAINTS paddle_adjustment_reconciliation_automatic_link_guard IMMEDIATE');
      const verifiedAutomaticResolution = await client.query(
        'SELECT status, resolution_source FROM paddle_adjustment_reconciliation_cases WHERE event_id = $1',
        [autoLinkAdjustmentEventId]
      );
      assert.deepEqual(verifiedAutomaticResolution.rows, [{
        status: 'resolved',
        resolution_source: 'automatic_provider_transaction_link'
      }]);
      await client.query('SAVEPOINT adjustment_event_immutable');
      let adjustmentMutationError;
      try {
        await client.query("UPDATE paddle_adjustment_events SET status = 'approved' WHERE event_id = $1",
          [adjustmentEventId]);
      } catch (error) { adjustmentMutationError = error; }
      assert.equal(adjustmentMutationError?.code, '55000');
      await client.query('ROLLBACK TO SAVEPOINT adjustment_event_immutable');
      await client.query('RELEASE SAVEPOINT adjustment_event_immutable');

      const transactionEventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
      await client.query(
        'INSERT INTO paddle_webhook_events (event_id, event_type) VALUES ($1, $2)',
        [transactionEventId, 'transaction.completed']
      );
      await client.query(
        `INSERT INTO paddle_transaction_events
         (event_id, transaction_id, user_id, plan, status, amount_minor_units, currency_code, occurred_at)
         VALUES ($1, $2, NULL, 'lifetime', 'completed', 1290, 'USD', statement_timestamp())`,
        [transactionEventId, `txn_${randomUUID().replace(/-/g, '')}`]
      );
      const transactionLedgerGuard = await client.query(
        `SELECT pg_get_functiondef('prevent_paddle_transaction_event_mutation()'::regprocedure) AS definition`
      );
      assert.match(transactionLedgerGuard.rows[0].definition, /Paddle transaction history is append-only/);
      const transactionLedgerTriggers = await client.query(
        `SELECT tgname FROM pg_trigger
         WHERE tgrelid = 'paddle_transaction_events'::regclass
           AND tgname IN ('paddle_transaction_events_append_only', 'paddle_transaction_events_no_truncate')
           AND NOT tgisinternal`
      );
      assert.equal(transactionLedgerTriggers.rowCount, 2);
      await client.query('SAVEPOINT transaction_event_immutable');
      let transactionEventMutationError;
      try {
        await client.query(
          `UPDATE paddle_transaction_events SET status = 'canceled' WHERE event_id = $1`,
          [transactionEventId]
        );
      } catch (error) { transactionEventMutationError = error; }
      assert.equal(transactionEventMutationError?.code, '55000');
      await client.query('ROLLBACK TO SAVEPOINT transaction_event_immutable');
      await client.query('RELEASE SAVEPOINT transaction_event_immutable');

      const adjustmentCaseGuard = await client.query(
        `SELECT pg_get_functiondef('guard_paddle_adjustment_reconciliation_case()'::regprocedure) AS definition`
      );
      assert.match(adjustmentCaseGuard.rows[0].definition, /Paddle reconciliation source evidence is immutable/);
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

      const l3AccessTrigger = await client.query(
        `SELECT tgname FROM pg_trigger
         WHERE tgrelid = 'identity_l3_media_access_events'::regclass
           AND tgname = 'identity_l3_media_access_events_append_only'
           AND NOT tgisinternal`
      );
      assert.equal(l3AccessTrigger.rowCount, 1,
        'L3 media access audit must have an installed UPDATE/DELETE trigger');
      const l3SnapshotTrigger = await client.query(
        `SELECT tgname FROM pg_trigger
         WHERE tgrelid = 'identity_l3_media_access_events'::regclass
           AND tgname = 'identity_l3_media_access_events_snapshot_refs'
           AND NOT tgisinternal`
      );
      assert.equal(l3SnapshotTrigger.rowCount, 1,
        'new L3 access events must automatically snapshot both provenance UUIDs');

      await client.query(`
        CREATE TEMP TABLE l3_access_append_only_test (
          submission_id uuid, moderator_user_id uuid,
          submission_ref uuid, moderator_ref uuid,
          access_type text, accessed_at timestamptz
        ) ON COMMIT DROP
      `);
      await client.query(`
        CREATE TRIGGER l3_access_snapshot_test
        BEFORE INSERT ON l3_access_append_only_test
        FOR EACH ROW EXECUTE FUNCTION snapshot_identity_l3_media_access_event_refs()
      `);
      await client.query(`
        CREATE TRIGGER l3_access_append_only_test
        BEFORE UPDATE OR DELETE ON l3_access_append_only_test
        FOR EACH ROW EXECUTE FUNCTION prevent_identity_l3_media_access_event_mutation()
      `);
      const l3SubmissionId = randomUUID();
      const l3ModeratorId = randomUUID();
      await client.query(
        `INSERT INTO l3_access_append_only_test
         VALUES ($1, $2, NULL, NULL, 'viewed', statement_timestamp())`,
        [l3SubmissionId, l3ModeratorId]
      );
      const l3SnapshotRow = await client.query(
        'SELECT submission_ref, moderator_ref FROM l3_access_append_only_test'
      );
      assert.deepEqual(l3SnapshotRow.rows, [{
        submission_ref: l3SubmissionId,
        moderator_ref: l3ModeratorId
      }], 'new L3 media access rows must snapshot the live submission and moderator UUIDs');
      await client.query('SAVEPOINT l3_access_no_rewrite');
      let l3AccessUpdateError;
      try {
        await client.query("UPDATE l3_access_append_only_test SET access_type = 'downloaded'");
      } catch (error) { l3AccessUpdateError = error; }
      assert.equal(l3AccessUpdateError?.code, '55000');
      await client.query('ROLLBACK TO SAVEPOINT l3_access_no_rewrite');
      await client.query('RELEASE SAVEPOINT l3_access_no_rewrite');

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
      const giftOrderSnapshotTrigger = await client.query(
        `SELECT tgname FROM pg_trigger
         WHERE tgrelid = 'gift_delivery_orders'::regclass
           AND tgname = 'gift_delivery_orders_snapshot_references'
           AND NOT tgisinternal`
      );
      assert.equal(giftOrderSnapshotTrigger.rowCount, 1,
        'new gift orders must snapshot catalog and delivery-partner UUIDs');
      const giftPartnerSnapshots = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'gift_delivery_orders'
           AND column_name IN (
             'delivery_partner_ref',
             'delivery_partner_key_snapshot',
             'delivery_partner_name_snapshot'
           )`
      );
      assert.equal(giftPartnerSnapshots.rowCount, 3,
        'gift orders must preserve partner UUID, stable key and display name after live partner deletion');
      const giftPartnerSnapshotFunction = await client.query(
        `SELECT pg_get_functiondef('snapshot_gift_delivery_order_references()'::regprocedure) AS definition`
      );
      assert.match(giftPartnerSnapshotFunction.rows[0].definition, /partner_key/);
      assert.match(giftPartnerSnapshotFunction.rows[0].definition, /display_name/);
      const giftCatalogDeleteRule = await client.query(
        `SELECT confdeltype FROM pg_constraint
         WHERE conrelid = 'gift_delivery_orders'::regclass
           AND contype = 'f'
           AND pg_get_constraintdef(oid) LIKE '%catalog_item_id%'`
      );
      assert.equal(giftCatalogDeleteRule.rows[0]?.confdeltype, 'n',
        'deleting a catalog item must null only the live FK while catalog_item_ref preserves provenance');
      const giftPartnerDeleteRule = await client.query(
        `SELECT confdeltype FROM pg_constraint
         WHERE conrelid = 'gift_delivery_orders'::regclass
           AND conname = 'gift_delivery_orders_delivery_partner_id_fkey'`
      );
      assert.equal(giftPartnerDeleteRule.rows[0]?.confdeltype, 'n',
        'deleting a delivery partner must null the live FK while retaining delivery_partner_ref');
      const giftActorSnapshot = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'gift_delivery_order_events' AND column_name = 'actor_ref'`
      );
      assert.equal(giftActorSnapshot.rowCount, 1);
      const giftActorSnapshotTrigger = await client.query(
        `SELECT tgname FROM pg_trigger
         WHERE tgrelid = 'gift_delivery_order_events'::regclass
           AND tgname = 'gift_delivery_order_events_snapshot_actor'
           AND NOT tgisinternal`
      );
      assert.equal(giftActorSnapshotTrigger.rowCount, 1,
        'gift events must snapshot the actor UUID at insertion time');

      await client.query(`
        CREATE TEMP TABLE gift_order_event_guard_test (
          actor_user_id uuid, actor_ref uuid, event_type text
        ) ON COMMIT DROP
      `);
      await client.query(`
        CREATE TRIGGER gift_order_event_snapshot_test
        BEFORE INSERT ON gift_order_event_guard_test
        FOR EACH ROW EXECUTE FUNCTION snapshot_gift_delivery_order_event_actor()
      `);
      await client.query(`
        CREATE TRIGGER gift_order_event_guard_test
        BEFORE UPDATE OR DELETE ON gift_order_event_guard_test
        FOR EACH ROW EXECUTE FUNCTION prevent_gift_delivery_order_event_mutation()
      `);
      const giftActorId = randomUUID();
      await client.query(
        'INSERT INTO gift_order_event_guard_test VALUES ($1, NULL, $2)',
        [giftActorId, 'request_created']
      );
      const giftActorRow = await client.query(
        'SELECT actor_user_id, actor_ref FROM gift_order_event_guard_test'
      );
      assert.deepEqual(giftActorRow.rows, [{
        actor_user_id: giftActorId,
        actor_ref: giftActorId
      }], 'new gift audit rows must snapshot the live actor UUID');
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
          product_name_snapshot text, product_category text,
          item_price_minor_units bigint, delivery_fee_minor_units bigint, delivery_fee_currency char(3),
          total_minor_units bigint, currency char(3), idempotency_key text,
          created_at timestamptz, expires_at timestamptz,
          catalog_item_id uuid, catalog_item_ref uuid, delivery_partner_id uuid, delivery_partner_ref uuid
        ) ON COMMIT DROP
      `);
      await client.query(`
        CREATE TRIGGER gift_order_reference_snapshot_test
        BEFORE INSERT ON gift_order_facts_guard_test
        FOR EACH ROW EXECUTE FUNCTION snapshot_gift_delivery_order_references()
      `);
      await client.query(`
        CREATE TRIGGER gift_order_facts_guard_test
        BEFORE UPDATE ON gift_order_facts_guard_test
        FOR EACH ROW EXECUTE FUNCTION guard_gift_delivery_order_immutable_facts()
      `);
      const catalogItemId = randomUUID();
      const deliveryPartnerId = randomUUID();
      await client.query(
        `INSERT INTO gift_order_facts_guard_test
         VALUES ($1, 'gift_ref', $2, $3, $4, 'snapshot', 'chocolate', 700, 300, 'USD', 1000,
                 'USD', 'idempotency', statement_timestamp(), statement_timestamp(), $5, NULL, $6, NULL)`,
        [randomUUID(), randomUUID(), randomUUID(), randomUUID(), catalogItemId, deliveryPartnerId]
      );
      const giftOrderSnapshots = await client.query(
        'SELECT catalog_item_id, catalog_item_ref, delivery_partner_id, delivery_partner_ref, item_price_minor_units, delivery_fee_minor_units, delivery_fee_currency, total_minor_units FROM gift_order_facts_guard_test'
      );
      assert.deepEqual(giftOrderSnapshots.rows[0], {
        catalog_item_id: catalogItemId,
        catalog_item_ref: catalogItemId,
        delivery_partner_id: deliveryPartnerId,
        delivery_partner_ref: deliveryPartnerId,
        item_price_minor_units: '700',
        delivery_fee_minor_units: '300',
        delivery_fee_currency: 'USD',
        total_minor_units: '1000'
      }, 'new gift orders must snapshot catalog and delivery partner references');
      await client.query('SAVEPOINT gift_order_facts_immutable');
      let giftOrderFactError;
      try {
        await client.query('UPDATE gift_order_facts_guard_test SET total_minor_units = 1');
      } catch (error) { giftOrderFactError = error; }
      assert.equal(giftOrderFactError?.code, '55000');
      await client.query('ROLLBACK TO SAVEPOINT gift_order_facts_immutable');
      await client.query('RELEASE SAVEPOINT gift_order_facts_immutable');

      for (const [column, value] of [
        ['item_price_minor_units', 701],
        ['delivery_fee_minor_units', 301],
        ['delivery_fee_currency', 'GEL']
      ]) {
        await client.query('SAVEPOINT gift_price_component_immutable');
        let priceComponentError;
        try {
          await client.query(`UPDATE gift_order_facts_guard_test SET ${column} = $1`, [value]);
        } catch (error) { priceComponentError = error; }
        assert.equal(priceComponentError?.code, '55000',
          `gift purchase component ${column} must be immutable`);
        await client.query('ROLLBACK TO SAVEPOINT gift_price_component_immutable');
        await client.query('RELEASE SAVEPOINT gift_price_component_immutable');
      }

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

      const l3GuardDefinition = await client.query(
        `SELECT pg_get_functiondef('prevent_identity_l3_media_access_event_mutation()'::regprocedure) AS definition`
      );
      assert.match(l3GuardDefinition.rows[0].definition, /pg_trigger_depth\(\) > 1/,
        'L3 provenance FK clearing must be limited to nested ON DELETE actions');
      const giftEventGuardDefinition = await client.query(
        `SELECT pg_get_functiondef('prevent_gift_delivery_order_event_mutation()'::regprocedure) AS definition`
      );
      assert.match(giftEventGuardDefinition.rows[0].definition, /pg_trigger_depth\(\) > 1/,
        'gift actor FK clearing must be limited to nested ON DELETE actions');

      await client.query(`
        CREATE TEMP TABLE l3_submission_fk_parent_test (id uuid PRIMARY KEY) ON COMMIT DROP
      `);
      await client.query(`
        CREATE TEMP TABLE l3_moderator_fk_parent_test (id uuid PRIMARY KEY) ON COMMIT DROP
      `);
      await client.query(`
        CREATE TEMP TABLE l3_fk_snapshot_guard_test (
          submission_id uuid REFERENCES l3_submission_fk_parent_test(id) ON DELETE SET NULL,
          moderator_user_id uuid REFERENCES l3_moderator_fk_parent_test(id) ON DELETE SET NULL,
          submission_ref uuid NOT NULL, moderator_ref uuid NOT NULL,
          access_type text NOT NULL, accessed_at timestamptz NOT NULL
        ) ON COMMIT DROP
      `);
      await client.query(`
        CREATE TRIGGER l3_fk_snapshot_guard_test
        BEFORE UPDATE OR DELETE ON l3_fk_snapshot_guard_test
        FOR EACH ROW EXECUTE FUNCTION prevent_identity_l3_media_access_event_mutation()
      `);
      const l3FkSubmissionId = randomUUID();
      const l3FkModeratorId = randomUUID();
      await client.query('INSERT INTO l3_submission_fk_parent_test VALUES ($1)', [l3FkSubmissionId]);
      await client.query('INSERT INTO l3_moderator_fk_parent_test VALUES ($1)', [l3FkModeratorId]);
      await client.query(
        `INSERT INTO l3_fk_snapshot_guard_test
         VALUES ($1, $2, $1, $2, 'viewed', statement_timestamp())`,
        [l3FkSubmissionId, l3FkModeratorId]
      );
      await client.query('SAVEPOINT l3_direct_fk_null_blocked');
      let l3DirectFkNullError;
      try {
        await client.query('UPDATE l3_fk_snapshot_guard_test SET submission_id = NULL');
      } catch (error) { l3DirectFkNullError = error; }
      assert.equal(l3DirectFkNullError?.code, '55000',
        'directly nulling an L3 live FK must not bypass append-only evidence protection');
      await client.query('ROLLBACK TO SAVEPOINT l3_direct_fk_null_blocked');
      await client.query('RELEASE SAVEPOINT l3_direct_fk_null_blocked');
      await client.query('DELETE FROM l3_submission_fk_parent_test WHERE id = $1', [l3FkSubmissionId]);
      await client.query('DELETE FROM l3_moderator_fk_parent_test WHERE id = $1', [l3FkModeratorId]);
      const l3FkAfterParentDelete = await client.query(
        'SELECT submission_id, moderator_user_id, submission_ref, moderator_ref FROM l3_fk_snapshot_guard_test'
      );
      assert.deepEqual(l3FkAfterParentDelete.rows, [{
        submission_id: null,
        moderator_user_id: null,
        submission_ref: l3FkSubmissionId,
        moderator_ref: l3FkModeratorId
      }], 'real FK cleanup must preserve both immutable L3 provenance snapshots');

      await client.query(`
        CREATE TEMP TABLE gift_actor_fk_parent_test (id uuid PRIMARY KEY) ON COMMIT DROP
      `);
      await client.query(`
        CREATE TEMP TABLE gift_event_fk_snapshot_guard_test (
          actor_user_id uuid REFERENCES gift_actor_fk_parent_test(id) ON DELETE SET NULL,
          actor_ref uuid NOT NULL, event_type text NOT NULL
        ) ON COMMIT DROP
      `);
      await client.query(`
        CREATE TRIGGER gift_event_fk_snapshot_guard_test
        BEFORE UPDATE OR DELETE ON gift_event_fk_snapshot_guard_test
        FOR EACH ROW EXECUTE FUNCTION prevent_gift_delivery_order_event_mutation()
      `);
      const giftFkActorId = randomUUID();
      await client.query('INSERT INTO gift_actor_fk_parent_test VALUES ($1)', [giftFkActorId]);
      await client.query(
        'INSERT INTO gift_event_fk_snapshot_guard_test VALUES ($1, $1, $2)',
        [giftFkActorId, 'request_created']
      );
      await client.query('SAVEPOINT gift_direct_actor_null_blocked');
      let giftDirectActorNullError;
      try {
        await client.query('UPDATE gift_event_fk_snapshot_guard_test SET actor_user_id = NULL');
      } catch (error) { giftDirectActorNullError = error; }
      assert.equal(giftDirectActorNullError?.code, '55000',
        'directly nulling a gift event actor FK must not bypass append-only protection');
      await client.query('ROLLBACK TO SAVEPOINT gift_direct_actor_null_blocked');
      await client.query('RELEASE SAVEPOINT gift_direct_actor_null_blocked');
      await client.query('DELETE FROM gift_actor_fk_parent_test WHERE id = $1', [giftFkActorId]);
      const giftFkAfterParentDelete = await client.query(
        'SELECT actor_user_id, actor_ref FROM gift_event_fk_snapshot_guard_test'
      );
      assert.deepEqual(giftFkAfterParentDelete.rows, [{
        actor_user_id: null,
        actor_ref: giftFkActorId
      }], 'real FK cleanup must preserve the immutable gift actor snapshot');

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


test('manual Paddle reconciliation resolution requires an immutable moderator audit row in the same transaction', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const moderatorId = randomUUID();
  const eventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO users (id, email, password_hash, role, status) VALUES ($1, $2, 'test-only-hash', 'moderator', 'active')",
      [moderatorId, `manual-adjustment-audit-${moderatorId}@example.invalid`]
    );
    await client.query(
      "INSERT INTO paddle_webhook_events (event_id, event_type) VALUES ($1, 'adjustment.created')",
      [eventId]
    );
    await client.query(
      "INSERT INTO paddle_adjustment_reconciliation_cases (event_id, reason_code) VALUES ($1, 'transaction_owner_unlinked')",
      [eventId]
    );

    await client.query('SAVEPOINT manual_resolution_without_audit');
    await client.query(
      `UPDATE paddle_adjustment_reconciliation_cases
       SET status = 'resolved', resolution_note = 'provider checked',
           resolution_source = 'manual_operator', resolved_by_ref = $2,
           resolved_at = statement_timestamp(), updated_at = statement_timestamp()
       WHERE event_id = $1`,
      [eventId, moderatorId]
    );
    let missingAuditError;
    try {
      await client.query('SET CONSTRAINTS paddle_adjustment_reconciliation_manual_audit_guard IMMEDIATE');
    } catch (error) { missingAuditError = error; }
    assert.equal(missingAuditError?.code, '23514',
      'manual resolution must fail at the database boundary if its audit row is missing');
    await client.query('ROLLBACK TO SAVEPOINT manual_resolution_without_audit');
    await client.query('RELEASE SAVEPOINT manual_resolution_without_audit');
    await client.query('SET CONSTRAINTS paddle_adjustment_reconciliation_manual_audit_guard DEFERRED');

    await client.query('SAVEPOINT manual_resolution_with_audit');
    await client.query(
      `UPDATE paddle_adjustment_reconciliation_cases
       SET status = 'resolved', resolution_note = 'provider checked',
           resolution_source = 'manual_operator', resolved_by_ref = $2,
           resolved_at = statement_timestamp(), updated_at = statement_timestamp()
       WHERE event_id = $1`,
      [eventId, moderatorId]
    );
    await client.query(
      `INSERT INTO moderation_audit_log
         (moderator_id, action, target_type, target_id, reason, details)
       VALUES ($1, 'paddle_adjustment_reconciliation_resolved',
               'paddle_adjustment_case', $2, 'provider checked',
               jsonb_build_object(
                 'eventId', $2::text,
                 'reasonCode', 'transaction_owner_unlinked',
                 'resolutionSource', 'manual_operator'
               ))`,
      [moderatorId, eventId]
    );
    await client.query('SET CONSTRAINTS paddle_adjustment_reconciliation_manual_audit_guard IMMEDIATE');
    const resolved = await client.query(
      'SELECT status, resolution_source FROM paddle_adjustment_reconciliation_cases WHERE event_id = $1',
      [eventId]
    );
    assert.deepEqual(resolved.rows, [{ status: 'resolved', resolution_source: 'manual_operator' }]);
    await client.query('ROLLBACK TO SAVEPOINT manual_resolution_with_audit');
    await client.query('RELEASE SAVEPOINT manual_resolution_with_audit');

    const memberId = randomUUID();
    const memberEventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
    await client.query(
      "INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, 'test-only-hash', 'active')",
      [memberId, `member-adjustment-audit-${memberId}@example.invalid`]
    );
    await client.query(
      "INSERT INTO paddle_webhook_events (event_id, event_type) VALUES ($1, 'adjustment.created')",
      [memberEventId]
    );
    await client.query(
      "INSERT INTO paddle_adjustment_reconciliation_cases (event_id, reason_code) VALUES ($1, 'transaction_owner_unlinked')",
      [memberEventId]
    );
    await client.query('SAVEPOINT member_resolution_with_audit');
    await client.query(
      `UPDATE paddle_adjustment_reconciliation_cases
       SET status = 'resolved', resolution_note = 'member attempted resolution',
           resolution_source = 'manual_operator', resolved_by_ref = $2,
           resolved_at = statement_timestamp(), updated_at = statement_timestamp()
       WHERE event_id = $1`,
      [memberEventId, memberId]
    );
    await client.query(
      `INSERT INTO moderation_audit_log
         (moderator_id, action, target_type, target_id, reason, details)
       VALUES ($1, 'paddle_adjustment_reconciliation_resolved',
               'paddle_adjustment_case', $2, 'member attempted resolution',
               jsonb_build_object(
                 'eventId', $2::text,
                 'reasonCode', 'transaction_owner_unlinked',
                 'resolutionSource', 'manual_operator'
               ))`,
      [memberId, memberEventId]
    );
    let memberRoleError;
    try {
      await client.query('SET CONSTRAINTS paddle_adjustment_reconciliation_manual_audit_guard IMMEDIATE');
    } catch (error) { memberRoleError = error; }
    assert.equal(memberRoleError?.code, '23514',
      'an active member without moderator/admin role must not resolve a reconciliation case even with an audit row');
    await client.query('ROLLBACK TO SAVEPOINT member_resolution_with_audit');
    await client.query('RELEASE SAVEPOINT member_resolution_with_audit');
    await client.query('ROLLBACK');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
});


test('user report status changes require an immutable audit row from an active moderator', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const reporterId = randomUUID();
  const targetId = randomUUID();
  const moderatorId = randomUUID();
  const reportId = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, 'test-only-hash', 'active'), ($3, $4, 'test-only-hash', 'active')",
      [reporterId, `reporter-audit-${reporterId}@example.invalid`, targetId, `target-audit-${targetId}@example.invalid`]
    );
    await client.query(
      "INSERT INTO users (id, email, password_hash, role, status) VALUES ($1, $2, 'test-only-hash', 'moderator', 'active')",
      [moderatorId, `report-moderator-audit-${moderatorId}@example.invalid`]
    );

    await client.query('SAVEPOINT report_insert_nonopen');
    let nonOpenInsertError;
    try {
      await client.query(
        `INSERT INTO user_reports (id, reporter_id, reported_user_id, category, details, status)
         VALUES ($1, $2, $3, 'spam', 'test evidence', 'resolved')`,
        [randomUUID(), reporterId, targetId]
      );
    } catch (error) { nonOpenInsertError = error; }
    assert.equal(nonOpenInsertError?.code, '23514',
      'a user report must not be inserted in an already-resolved state');
    await client.query('ROLLBACK TO SAVEPOINT report_insert_nonopen');
    await client.query('RELEASE SAVEPOINT report_insert_nonopen');

    await client.query(
      `INSERT INTO user_reports (id, reporter_id, reported_user_id, category, details)
       VALUES ($1, $2, $3, 'spam', 'test evidence')`,
      [reportId, reporterId, targetId]
    );

    await client.query('SAVEPOINT report_status_without_audit');
    await client.query(
      "UPDATE user_reports SET status = 'resolved' WHERE id = $1",
      [reportId]
    );
    let missingReportAuditError;
    try {
      await client.query('SET CONSTRAINTS user_reports_status_audit_guard IMMEDIATE');
    } catch (error) { missingReportAuditError = error; }
    assert.equal(missingReportAuditError?.code, '23514',
      'a report status transition must fail if its moderator audit row is missing');
    await client.query('ROLLBACK TO SAVEPOINT report_status_without_audit');
    await client.query('RELEASE SAVEPOINT report_status_without_audit');
    await client.query('SET CONSTRAINTS user_reports_status_audit_guard DEFERRED');

    await client.query('SAVEPOINT report_status_with_audit');
    await client.query(
      "UPDATE user_reports SET status = 'resolved' WHERE id = $1",
      [reportId]
    );
    await client.query(
      `INSERT INTO moderation_audit_log
         (moderator_id, action, target_type, target_id, reason, details)
       VALUES ($1, 'resolve', 'user_report', $2, 'reviewed',
               jsonb_build_object('newStatus', 'resolved', 'targetUserId', $3::text, 'category', 'spam'))`,
      [moderatorId, reportId, targetId]
    );
    await client.query('SET CONSTRAINTS user_reports_status_audit_guard IMMEDIATE');
    const resolved = await client.query('SELECT status FROM user_reports WHERE id = $1', [reportId]);
    assert.equal(resolved.rows[0].status, 'resolved');
    await client.query('ROLLBACK TO SAVEPOINT report_status_with_audit');
    await client.query('RELEASE SAVEPOINT report_status_with_audit');

    await client.query('SAVEPOINT report_status_member_audit');
    await client.query(
      "UPDATE user_reports SET status = 'resolved' WHERE id = $1",
      [reportId]
    );
    await client.query(
      `INSERT INTO moderation_audit_log
         (moderator_id, action, target_type, target_id, reason, details)
       VALUES ($1, 'resolve', 'user_report', $2, 'member attempt',
               jsonb_build_object('newStatus', 'resolved', 'targetUserId', $3::text, 'category', 'spam'))`,
      [reporterId, reportId, targetId]
    );
    let memberReportAuditError;
    try {
      await client.query('SET CONSTRAINTS user_reports_status_audit_guard IMMEDIATE');
    } catch (error) { memberReportAuditError = error; }
    assert.equal(memberReportAuditError?.code, '23514',
      'a matching audit row written by an active member must not authorize a moderation transition');
    await client.query('ROLLBACK TO SAVEPOINT report_status_member_audit');
    await client.query('RELEASE SAVEPOINT report_status_member_audit');
    await client.query('ROLLBACK');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
});


test('photo and safety screening review states require matching moderator or automated audit evidence', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const ownerId = randomUUID();
  const moderatorId = randomUUID();
  const autoPhotoId = randomUUID();
  const manualPhotoId = randomUUID();
  const screeningId = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, 'test-only-hash', 'active')",
      [ownerId, `review-owner-${ownerId}@example.invalid`]
    );
    await client.query(
      "INSERT INTO users (id, email, password_hash, role, status) VALUES ($1, $2, 'test-only-hash', 'moderator', 'active')",
      [moderatorId, `review-moderator-${moderatorId}@example.invalid`]
    );

    await client.query('SAVEPOINT auto_photo_without_audit');
    await client.query(
      `INSERT INTO photo_assets
         (id, user_id, storage_path, mime_type, byte_size, width, height, review_status)
       VALUES ($1, $2, $3, 'image/jpeg', 100, 10, 10, 'approved')`,
      [autoPhotoId, ownerId, `/tmp/${autoPhotoId}.jpg`]
    );
    let missingAutoPhotoAudit;
    try {
      await client.query('SET CONSTRAINTS photo_assets_review_audit_guard IMMEDIATE');
    } catch (error) { missingAutoPhotoAudit = error; }
    assert.equal(missingAutoPhotoAudit?.code, '23514',
      'an automatically approved photo insert must carry its AI decision evidence');
    await client.query('ROLLBACK TO SAVEPOINT auto_photo_without_audit');
    await client.query('RELEASE SAVEPOINT auto_photo_without_audit');
    await client.query('SET CONSTRAINTS photo_assets_review_audit_guard DEFERRED');

    await client.query('SAVEPOINT auto_photo_with_audit');
    await client.query(
      `INSERT INTO photo_assets
         (id, user_id, storage_path, mime_type, byte_size, width, height, review_status)
       VALUES ($1, $2, $3, 'image/jpeg', 100, 10, 10, 'approved')`,
      [autoPhotoId, ownerId, `/tmp/${autoPhotoId}.jpg`]
    );
    await client.query(
      `INSERT INTO moderation_audit_log (action, target_type, target_id, reason, details)
       VALUES ('photo_ai_approved', 'photo', $1, 'automated review passed',
               jsonb_build_object('engine', 'test-engine', 'userId', $2::text))`,
      [autoPhotoId, ownerId]
    );
    await client.query('SET CONSTRAINTS photo_assets_review_audit_guard IMMEDIATE');
    await client.query('ROLLBACK TO SAVEPOINT auto_photo_with_audit');
    await client.query('RELEASE SAVEPOINT auto_photo_with_audit');
    await client.query('SET CONSTRAINTS photo_assets_review_audit_guard DEFERRED');

    await client.query(
      `INSERT INTO photo_assets
         (id, user_id, storage_path, mime_type, byte_size, width, height, review_status)
       VALUES ($1, $2, $3, 'image/jpeg', 100, 10, 10, 'pending')`,
      [manualPhotoId, ownerId, `/tmp/${manualPhotoId}.jpg`]
    );

    // Keep the AI decision's owner UUID in the append-only audit even when
    // account deletion later removes the private photo row and file.
    await client.query(
      `INSERT INTO photo_assets
         (id, user_id, storage_path, mime_type, byte_size, width, height, review_status)
       VALUES ($1, $2, $3, 'image/jpeg', 100, 10, 10, 'approved')`,
      [autoPhotoId, ownerId, `/tmp/${autoPhotoId}.jpg`]
    );
    await client.query(
      `INSERT INTO moderation_audit_log (action, target_type, target_id, reason, details)
       VALUES ('photo_ai_approved', 'photo', $1, 'automated review passed',
               jsonb_build_object('engine', 'test-engine', 'userId', $2::text))`,
      [autoPhotoId, ownerId]
    );
    await client.query('SET CONSTRAINTS photo_assets_review_audit_guard IMMEDIATE');
    await client.query('SET CONSTRAINTS photo_assets_review_audit_guard DEFERRED');

    await client.query('SAVEPOINT photo_asset_metadata_immutable');
    let photoMetadataMutationError;
    try {
      await client.query(
        'UPDATE photo_assets SET storage_path = $2 WHERE id = $1',
        [manualPhotoId, `/tmp/rewritten-${manualPhotoId}.jpg`]
      );
    } catch (error) { photoMetadataMutationError = error; }
    assert.equal(photoMetadataMutationError?.code, '55000',
      'photo storage identity and upload metadata must not be rewritten after upload');
    await client.query('ROLLBACK TO SAVEPOINT photo_asset_metadata_immutable');
    await client.query('RELEASE SAVEPOINT photo_asset_metadata_immutable');

    await client.query('SAVEPOINT photo_assets_truncate_blocked');
    let photoAssetsTruncateError;
    try { await client.query('TRUNCATE photo_assets'); }
    catch (error) { photoAssetsTruncateError = error; }
    assert.equal(photoAssetsTruncateError?.code, '55000',
      'photo review evidence must not be removed with TRUNCATE');
    await client.query('ROLLBACK TO SAVEPOINT photo_assets_truncate_blocked');
    await client.query('RELEASE SAVEPOINT photo_assets_truncate_blocked');
    await client.query('SAVEPOINT manual_photo_without_audit');
    await client.query(
      "UPDATE photo_assets SET review_status = 'approved' WHERE id = $1",
      [manualPhotoId]
    );
    let missingManualPhotoAudit;
    try {
      await client.query('SET CONSTRAINTS photo_assets_review_audit_guard IMMEDIATE');
    } catch (error) { missingManualPhotoAudit = error; }
    assert.equal(missingManualPhotoAudit?.code, '23514',
      'manual photo approval must fail without an active moderator audit row');
    await client.query('ROLLBACK TO SAVEPOINT manual_photo_without_audit');
    await client.query('RELEASE SAVEPOINT manual_photo_without_audit');
    await client.query('SET CONSTRAINTS photo_assets_review_audit_guard DEFERRED');

    await client.query('SAVEPOINT manual_photo_with_audit');
    await client.query(
      "UPDATE photo_assets SET review_status = 'approved' WHERE id = $1",
      [manualPhotoId]
    );
    await client.query(
      `INSERT INTO moderation_audit_log
         (moderator_id, action, target_type, target_id, details)
       VALUES ($1, 'photo_approved', 'photo_asset', $2,
               jsonb_build_object('userId', $3::text))`,
      [moderatorId, manualPhotoId, ownerId]
    );
    await client.query('SET CONSTRAINTS photo_assets_review_audit_guard IMMEDIATE');
    await client.query('ROLLBACK TO SAVEPOINT manual_photo_with_audit');
    await client.query('RELEASE SAVEPOINT manual_photo_with_audit');
    await client.query('SET CONSTRAINTS photo_assets_review_audit_guard DEFERRED');

    await client.query(
      `INSERT INTO user_safety_screenings
         (id, user_id, scope, flags, severity, review_status)
       VALUES ($1, $2, 'profile', '[]'::jsonb, 'low', 'pending')`,
      [screeningId, ownerId]
    );

    await client.query('SAVEPOINT screening_without_live_owner');
    let missingScreeningOwnerError;
    try {
      await client.query(
        `INSERT INTO user_safety_screenings
           (id, user_id, scope, flags, severity, review_status)
         VALUES ($1, NULL, 'profile', '[]'::jsonb, 'low', 'pending')`,
        [randomUUID()]
      );
    } catch (error) { missingScreeningOwnerError = error; }
    assert.equal(missingScreeningOwnerError?.code, '23502',
      'new screenings must snapshot a live account rather than inventing an owner UUID');
    await client.query('ROLLBACK TO SAVEPOINT screening_without_live_owner');
    await client.query('RELEASE SAVEPOINT screening_without_live_owner');

    await client.query('SAVEPOINT screening_classification_immutable');
    let screeningClassificationMutationError;
    try {
      await client.query(
        "UPDATE user_safety_screenings SET severity = 'none' WHERE id = $1",
        [screeningId]
      );
    } catch (error) { screeningClassificationMutationError = error; }
    assert.equal(screeningClassificationMutationError?.code, '55000',
      'screening severity, flags, scope and engine evidence must remain immutable after creation');
    await client.query('ROLLBACK TO SAVEPOINT screening_classification_immutable');
    await client.query('RELEASE SAVEPOINT screening_classification_immutable');

    await client.query('SAVEPOINT screening_owner_nullification');
    let directScreeningOwnerNullificationError;
    try {
      await client.query('UPDATE user_safety_screenings SET user_id = NULL WHERE id = $1',
        [screeningId]);
    } catch (error) { directScreeningOwnerNullificationError = error; }
    assert.equal(directScreeningOwnerNullificationError?.code, '55000',
      'only nested account-deletion FK actions may clear the live screening owner');
    await client.query('ROLLBACK TO SAVEPOINT screening_owner_nullification');
    await client.query('RELEASE SAVEPOINT screening_owner_nullification');

    await client.query('SAVEPOINT screening_delete_blocked');
    let screeningDeleteError;
    try { await client.query('DELETE FROM user_safety_screenings WHERE id = $1', [screeningId]); }
    catch (error) { screeningDeleteError = error; }
    assert.equal(screeningDeleteError?.code, '55000',
      'safety screening evidence must not be deleted directly');
    await client.query('ROLLBACK TO SAVEPOINT screening_delete_blocked');
    await client.query('RELEASE SAVEPOINT screening_delete_blocked');

    await client.query('SAVEPOINT screening_truncate_blocked');
    let screeningTruncateError;
    try { await client.query('TRUNCATE user_safety_screenings'); }
    catch (error) { screeningTruncateError = error; }
    assert.equal(screeningTruncateError?.code, '55000',
      'safety screening evidence must not be removed with TRUNCATE');
    await client.query('ROLLBACK TO SAVEPOINT screening_truncate_blocked');
    await client.query('RELEASE SAVEPOINT screening_truncate_blocked');
    await client.query('SAVEPOINT screening_metadata_without_transition');
    let reviewerMetadataError;
    try {
      await client.query(
        "UPDATE user_safety_screenings SET reviewed_at = statement_timestamp(), reviewed_by = $2 WHERE id = $1",
        [screeningId, moderatorId]
      );
      await client.query('SET CONSTRAINTS user_safety_screenings_review_audit_guard IMMEDIATE');
    } catch (error) { reviewerMetadataError = error; }
    assert.equal(reviewerMetadataError?.code, '23514',
      'reviewer identity/time cannot be forged without a review-state transition');
    await client.query('ROLLBACK TO SAVEPOINT screening_metadata_without_transition');
    await client.query('RELEASE SAVEPOINT screening_metadata_without_transition');
    await client.query('SET CONSTRAINTS user_safety_screenings_review_audit_guard DEFERRED');

    await client.query('SAVEPOINT screening_without_audit');
    await client.query(
      "UPDATE user_safety_screenings SET review_status = 'cleared', reviewed_at = statement_timestamp(), reviewed_by = $2 WHERE id = $1",
      [screeningId, moderatorId]
    );
    let missingScreeningAudit;
    try {
      await client.query('SET CONSTRAINTS user_safety_screenings_review_audit_guard IMMEDIATE');
    } catch (error) { missingScreeningAudit = error; }
    assert.equal(missingScreeningAudit?.code, '23514',
      'screening clearance must fail without matching active moderator evidence');
    await client.query('ROLLBACK TO SAVEPOINT screening_without_audit');
    await client.query('RELEASE SAVEPOINT screening_without_audit');
    await client.query('SET CONSTRAINTS user_safety_screenings_review_audit_guard DEFERRED');

    await client.query('SAVEPOINT screening_with_audit');
    await client.query(
      "UPDATE user_safety_screenings SET review_status = 'cleared', reviewed_at = statement_timestamp(), reviewed_by = $2 WHERE id = $1",
      [screeningId, moderatorId]
    );
    await client.query(
      `INSERT INTO moderation_audit_log
         (moderator_id, action, target_type, target_id, details)
       VALUES ($1, 'screening_cleared', 'safety_screening', $2,
               jsonb_build_object('userId', $3::text, 'newStatus', 'cleared'))`,
      [moderatorId, screeningId, ownerId]
    );
    await client.query('SET CONSTRAINTS user_safety_screenings_review_audit_guard IMMEDIATE');
    const screening = await client.query(
      'SELECT review_status, reviewed_by FROM user_safety_screenings WHERE id = $1',
      [screeningId]
    );
    assert.deepEqual(screening.rows, [{ review_status: 'cleared', reviewed_by: moderatorId }]);

    // A direct SQL UPDATE must not imitate the ON DELETE SET NULL FK action.
    // The BEFORE trigger may allow the nested referential action, but a normal
    // caller has trigger depth 1 and must not erase the live reviewer link.
    await client.query('SAVEPOINT direct_screening_reviewer_nullification');
    let directReviewerNullificationError;
    try {
      await client.query(
        'UPDATE user_safety_screenings SET reviewed_by = NULL WHERE id = $1',
        [screeningId]
      );
    } catch (error) { directReviewerNullificationError = error; }
    assert.equal(directReviewerNullificationError?.code, '23514',
      'direct SQL must not bypass reviewer metadata immutability by clearing reviewed_by');
    await client.query('ROLLBACK TO SAVEPOINT direct_screening_reviewer_nullification');
    await client.query('RELEASE SAVEPOINT direct_screening_reviewer_nullification');

    // The actual nested FK action remains permitted and preserves the opaque
    // reviewer snapshot in the append-only moderation audit.
    await client.query('DELETE FROM users WHERE id = $1', [moderatorId]);
    const retainedScreening = await client.query(
      'SELECT review_status, reviewed_at, reviewed_by FROM user_safety_screenings WHERE id = $1',
      [screeningId]
    );
    assert.equal(retainedScreening.rows[0].review_status, 'cleared');
    assert.ok(retainedScreening.rows[0].reviewed_at instanceof Date);
    assert.equal(retainedScreening.rows[0].reviewed_by, null,
      'the nested FK nullification may clear the live moderator FK without erasing the review decision');
    const retainedAudit = await client.query(
      "SELECT moderator_id, moderator_ref FROM moderation_audit_log WHERE target_type = 'safety_screening' AND target_id = $1",
      [screeningId]
    );
    assert.deepEqual(retainedAudit.rows, [{ moderator_id: null, moderator_ref: moderatorId }],
      'the append-only audit snapshot must preserve the reviewer UUID after account deletion');

    // Physical account removal may clear the live screening FK, but its
    // immutable owner UUID and classification evidence must survive.
    await client.query('DELETE FROM users WHERE id = $1', [ownerId]);
    const retainedOwnerSnapshot = await client.query(
      'SELECT user_id, user_ref, severity, flags, scope FROM user_safety_screenings WHERE id = $1',
      [screeningId]
    );
    assert.deepEqual(retainedOwnerSnapshot.rows, [{
      user_id: null, user_ref: ownerId, severity: 'low', flags: [], scope: 'profile'
    }]);

    const retainedPhotoDecision = await client.query(
      `SELECT details->>'userId' AS user_id
       FROM moderation_audit_log
       WHERE action = 'photo_ai_approved' AND target_type = 'photo' AND target_id = $1`,
      [autoPhotoId]
    );
    assert.deepEqual(retainedPhotoDecision.rows, [{ user_id: ownerId }],
      'AI photo decision evidence must retain the uploader UUID after privacy deletion removes the photo row');
    await client.query('ROLLBACK TO SAVEPOINT screening_with_audit');
    await client.query('RELEASE SAVEPOINT screening_with_audit');
    await client.query('ROLLBACK');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
});


test('Paddle transaction evidence stores signed gross and net totals after credits', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const eventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
  const transactionId = `txn_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO paddle_webhook_events (event_id, event_type) VALUES ($1, 'transaction.completed')",
      [eventId]
    );
    await client.query(
      `INSERT INTO paddle_transaction_events
         (event_id, transaction_id, status, amount_minor_units,
          grand_total_minor_units, credit_minor_units, balance_minor_units, currency_code)
       VALUES ($1, $2, 'completed', -500, -500, 0, 0, 'GEL')`,
      [eventId, transactionId]
    );
    const result = await client.query(
      `SELECT amount_minor_units, grand_total_minor_units,
              credit_minor_units, balance_minor_units, currency_code
       FROM paddle_transaction_events WHERE event_id = $1`,
      [eventId]
    );
    assert.deepEqual(result.rows, [{
      amount_minor_units: '-500',
      grand_total_minor_units: '-500',
      credit_minor_units: '0',
      balance_minor_units: '0',
      currency_code: 'GEL'
    }]);

    await client.query('SAVEPOINT unsafe_transaction_amount');
    const unsafeEventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
    await client.query(
      "INSERT INTO paddle_webhook_events (event_id, event_type) VALUES ($1, 'transaction.completed')",
      [unsafeEventId]
    );
    let unsafeAmountError;
    try {
      await client.query(
        `INSERT INTO paddle_transaction_events
           (event_id, transaction_id, status, amount_minor_units, currency_code)
         VALUES ($1, $2, 'completed', 9007199254740992, 'GEL')`,
        [unsafeEventId, `txn_${randomUUID().replace(/-/g, '')}`]
      );
    } catch (error) { unsafeAmountError = error; }
    assert.equal(unsafeAmountError?.code, '23514',
      'signed transaction amounts must remain within the exact JavaScript integer range');
    await client.query('ROLLBACK TO SAVEPOINT unsafe_transaction_amount');
    await client.query('RELEASE SAVEPOINT unsafe_transaction_amount');
    await client.query('ROLLBACK');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
});


test('captured recurring subscription evidence is paid, owner-bound, and distinct from transaction completion', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const ownerId = randomUUID();
  const otherOwnerId = randomUUID();
  const subscriptionId = 'sub_0123456789abcdef01234567';
  const customerId = 'ctm_0123456789abcdef01234567';
  const transactionId = `txn_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
  const otherTransactionId = `txn_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO users (id, email, password_hash, status, paddle_subscription_id, paddle_customer_id) VALUES ($1, $2, 'test-only-hash', 'active', NULL, NULL), ($3, $4, 'test-only-hash', 'active', 'sub_1123456789abcdef01234567', 'ctm_1123456789abcdef01234567')",
      [ownerId, `paid-evidence-${ownerId}@example.invalid`,
        otherOwnerId, `paid-evidence-other-${otherOwnerId}@example.invalid`]
    );

    const attemptId = randomUUID();
    await client.query(
      `INSERT INTO paddle_checkout_attempts
       (user_id, attempt_id, plan, status, created_at, updated_at)
       VALUES ($1, $2, '1month', 'creating', statement_timestamp(), statement_timestamp())`,
      [ownerId, attemptId]
    );
    await client.query(
      `UPDATE paddle_checkout_attempts
       SET transaction_id = $2, status = 'completed', updated_at = statement_timestamp()
       WHERE user_id = $1`,
      [ownerId, transactionId]
    );
    const earlyPaidEventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
    await client.query(
      "INSERT INTO paddle_webhook_events (event_id, event_type) VALUES ($1, 'transaction.paid')",
      [earlyPaidEventId]
    );
    await client.query(
      `INSERT INTO paddle_transaction_events
       (event_id, transaction_id, user_id, plan, status, customer_id)
       VALUES ($1, $2, $3, '1month', 'paid', $4)`,
      [earlyPaidEventId, transactionId, ownerId, customerId]
    );
    await client.query(
      "UPDATE users SET paddle_subscription_id = $2, paddle_customer_id = $3 WHERE id = $1",
      [ownerId, subscriptionId, customerId]
    );
    const subscriptionEventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
    await client.query(
      "INSERT INTO paddle_webhook_events (event_id, event_type) VALUES ($1, 'subscription.created')",
      [subscriptionEventId]
    );
    await client.query(
      `INSERT INTO paddle_transaction_events
       (event_id, transaction_id, user_id, plan, status, subscription_id, customer_id)
       VALUES ($1, $2, $3, '1month', 'paid', $4, $5)`,
      [subscriptionEventId, transactionId, ownerId, subscriptionId, customerId]
    );
    await client.query(
      `UPDATE paddle_checkout_attempts
       SET status = 'linked', updated_at = statement_timestamp()
       WHERE user_id = $1 AND attempt_id = $2`,
      [ownerId, attemptId]
    );
    await client.query('SET CONSTRAINTS paddle_checkout_attempts_linked_transaction_evidence_guard IMMEDIATE');

    const otherAttemptId = randomUUID();
    await client.query(
      `INSERT INTO paddle_checkout_attempts
       (user_id, attempt_id, plan, status, created_at, updated_at)
       VALUES ($1, $2, '1month', 'creating', statement_timestamp(), statement_timestamp())`,
      [otherOwnerId, otherAttemptId]
    );
    await client.query(
      `UPDATE paddle_checkout_attempts
       SET transaction_id = $2, status = 'completed', updated_at = statement_timestamp()
       WHERE user_id = $1`,
      [otherOwnerId, otherTransactionId]
    );
    const mismatchedEventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
    await client.query(
      "INSERT INTO paddle_webhook_events (event_id, event_type) VALUES ($1, 'transaction.paid')",
      [mismatchedEventId]
    );
    await client.query(
      `INSERT INTO paddle_transaction_events
       (event_id, transaction_id, user_id, plan, status, customer_id)
       VALUES ($1, $2, $3, '1month', 'paid', 'ctm_1123456789abcdef01234567')`,
      [mismatchedEventId, otherTransactionId, otherOwnerId]
    );
    await client.query('SET CONSTRAINTS paddle_checkout_attempts_linked_transaction_evidence_guard DEFERRED');
    await client.query('SAVEPOINT mismatched_subscription_identity');
    await client.query(
      `UPDATE paddle_checkout_attempts
       SET status = 'linked', updated_at = statement_timestamp()
       WHERE user_id = $1 AND attempt_id = $2`,
      [otherOwnerId, otherAttemptId]
    );
    let mismatchError;
    try {
      await client.query('SET CONSTRAINTS paddle_checkout_attempts_linked_transaction_evidence_guard IMMEDIATE');
    } catch (error) { mismatchError = error; }
    assert.equal(mismatchError?.code, '23514',
      'subscription.created paid evidence must match the exact stored owner subscription and customer IDs');
    await client.query('ROLLBACK TO SAVEPOINT mismatched_subscription_identity');
    await client.query('RELEASE SAVEPOINT mismatched_subscription_identity');
    await client.query('ROLLBACK');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
});

test('provider identity reconciliation retains immutable minimal context and audits its manual resolution', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const moderatorId = randomUUID();
  const ownerId = randomUUID();
  const eventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
  const transactionId = `txn_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO users (id, email, password_hash, role, status) VALUES ($1, $2, 'test-only-hash', 'moderator', 'active'), ($3, $4, 'test-only-hash', 'member', 'active')",
      [moderatorId, `provider-case-mod-${moderatorId}@example.invalid`,
        ownerId, `provider-case-owner-${ownerId}@example.invalid`]
    );
    await client.query(
      "INSERT INTO paddle_webhook_events (event_id, event_type) VALUES ($1, 'transaction.completed')",
      [eventId]
    );
    await client.query(
      `INSERT INTO paddle_adjustment_reconciliation_cases
       (event_id, reason_code, provider_transaction_id, provider_user_ref, provider_plan)
       VALUES ($1, 'provider_identity_conflict', $2, $3, '1month')`,
      [eventId, transactionId, ownerId]
    );
    await client.query('SAVEPOINT immutable_provider_case_context');
    let immutableContextError;
    try {
      await client.query(
        'UPDATE paddle_adjustment_reconciliation_cases SET provider_plan = $2 WHERE event_id = $1',
        [eventId, '3months']
      );
    } catch (error) { immutableContextError = error; }
    assert.equal(immutableContextError?.code, '55000',
      'provider transaction, owner and plan context must not be rewritten after queueing');
    await client.query('ROLLBACK TO SAVEPOINT immutable_provider_case_context');
    await client.query('RELEASE SAVEPOINT immutable_provider_case_context');

    await client.query(
      `UPDATE paddle_adjustment_reconciliation_cases
       SET status = 'resolved', resolution_note = 'Provider event and account ownership verified',
           resolution_source = 'manual_operator', resolved_by_ref = $2,
           resolved_at = statement_timestamp(), updated_at = statement_timestamp()
       WHERE event_id = $1`,
      [eventId, moderatorId]
    );
    await client.query(
      `INSERT INTO moderation_audit_log
       (moderator_id, action, target_type, target_id, reason, details)
       VALUES ($1, 'paddle_adjustment_reconciliation_resolved',
               'paddle_adjustment_case', $2, 'Provider event and account ownership verified',
               jsonb_build_object(
                 'eventId', $2::text,
                 'reasonCode', 'provider_identity_conflict',
                 'transactionId', $3::text,
                 'providerUserRef', $4::text,
                 'providerPlan', '1month',
                 'resolutionSource', 'manual_operator'
               ))`,
      [moderatorId, eventId, transactionId, ownerId]
    );
    await client.query('SET CONSTRAINTS paddle_adjustment_reconciliation_manual_audit_guard IMMEDIATE');
    const resolved = await client.query(
      `SELECT status, provider_transaction_id, provider_user_ref, provider_plan
       FROM paddle_adjustment_reconciliation_cases WHERE event_id = $1`,
      [eventId]
    );
    assert.deepEqual(resolved.rows, [{
      status: 'resolved',
      provider_transaction_id: transactionId,
      provider_user_ref: ownerId,
      provider_plan: '1month'
    }]);
    await client.query('ROLLBACK');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
});

test('captured recurring payment can automatically resolve only its uniquely linked adjustment case', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const userId = randomUUID();
  const transactionId = `txn_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
  const subscriptionId = 'sub_0123456789abcdef01234567';
  const customerId = 'ctm_0123456789abcdef01234567';
  const subscriptionEventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
  const adjustmentEventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO users (id, email, password_hash, status, paddle_subscription_id, paddle_customer_id) VALUES ($1, $2, 'test-only-hash', 'active', $3, $4)",
      [userId, `paid-adjustment-${userId}@example.invalid`, subscriptionId, customerId]
    );
    await client.query(
      "INSERT INTO paddle_webhook_events (event_id, event_type) VALUES ($1, 'subscription.created')",
      [subscriptionEventId]
    );
    await client.query(
      `INSERT INTO paddle_transaction_events
       (event_id, transaction_id, user_id, plan, status, subscription_id, customer_id)
       VALUES ($1, $2, $3, '1month', 'paid', $4, $5)`,
      [subscriptionEventId, transactionId, userId, subscriptionId, customerId]
    );
    await client.query(
      "INSERT INTO paddle_webhook_events (event_id, event_type) VALUES ($1, 'adjustment.created')",
      [adjustmentEventId]
    );
    await client.query(
      `INSERT INTO paddle_adjustment_events
       (event_id, adjustment_id, transaction_id, action, adjustment_type, status, occurred_at)
       VALUES ($1, $2, $3, 'refund', 'partial', 'pending_approval', statement_timestamp())`,
      [adjustmentEventId, `adj_${randomUUID().replace(/-/g, '').slice(0, 26)}`, transactionId]
    );
    await client.query(
      `INSERT INTO paddle_adjustment_reconciliation_cases
       (event_id, reason_code) VALUES ($1, 'transaction_owner_unlinked')`,
      [adjustmentEventId]
    );
    await client.query(
      `UPDATE paddle_adjustment_reconciliation_cases
       SET status = 'resolved',
           resolution_note = 'Verified recurring captured payment owner',
           resolution_source = 'automatic_provider_transaction_link',
           resolved_by_ref = NULL,
           resolved_at = statement_timestamp(),
           updated_at = statement_timestamp()
       WHERE event_id = $1`,
      [adjustmentEventId]
    );
    await client.query('SET CONSTRAINTS paddle_adjustment_reconciliation_automatic_link_guard IMMEDIATE');
    const resolved = await client.query(
      'SELECT status, resolution_source FROM paddle_adjustment_reconciliation_cases WHERE event_id = $1',
      [adjustmentEventId]
    );
    assert.deepEqual(resolved.rows, [{
      status: 'resolved', resolution_source: 'automatic_provider_transaction_link'
    }]);
    await client.query('ROLLBACK');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
});

test('Paddle transaction IDs remain globally unique across current and archived checkout attempts', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const firstUserId = randomUUID();
  const secondUserId = randomUUID();
  const thirdUserId = randomUUID();
  const transactionId = `txn_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, 'test-only-hash', 'active'), ($3, $4, 'test-only-hash', 'active'), ($5, $6, 'test-only-hash', 'active')",
      [firstUserId, `txn-history-a-${firstUserId}@example.invalid`,
        secondUserId, `txn-history-b-${secondUserId}@example.invalid`,
        thirdUserId, `txn-history-c-${thirdUserId}@example.invalid`]
    );

    const firstAttemptId = randomUUID();
    await client.query(
      `INSERT INTO paddle_checkout_attempts
       (user_id, attempt_id, plan, status, created_at, updated_at)
       VALUES ($1, $2, '1month', 'creating', statement_timestamp(), statement_timestamp())`,
      [firstUserId, firstAttemptId]
    );
    await client.query(
      `UPDATE paddle_checkout_attempts
       SET transaction_id = $2, status = 'canceled', updated_at = statement_timestamp()
       WHERE user_id = $1 AND attempt_id = $3`,
      [firstUserId, transactionId, firstAttemptId]
    );

    const nextAttemptId = randomUUID();
    await client.query(
      `UPDATE paddle_checkout_attempts
       SET attempt_id = $2, transaction_id = NULL, plan = '1month',
           status = 'creating', created_at = statement_timestamp(), updated_at = statement_timestamp()
       WHERE user_id = $1`,
      [firstUserId, nextAttemptId]
    );
    const archived = await client.query(
      'SELECT user_id, attempt_id, transaction_id FROM paddle_checkout_attempt_history WHERE transaction_id = $1',
      [transactionId]
    );
    assert.deepEqual(archived.rows, [{
      user_id: firstUserId, attempt_id: firstAttemptId, transaction_id: transactionId
    }], 'terminal rollover must retain the original transaction owner');

    const secondAttemptId = randomUUID();
    await client.query(
      `INSERT INTO paddle_checkout_attempts
       (user_id, attempt_id, plan, status, created_at, updated_at)
       VALUES ($1, $2, '1month', 'creating', statement_timestamp(), statement_timestamp())`,
      [secondUserId, secondAttemptId]
    );
    await client.query('SAVEPOINT duplicate_archived_transaction');
    let duplicateTransactionError;
    try {
      await client.query(
        `UPDATE paddle_checkout_attempts
         SET transaction_id = $2, status = 'completed', updated_at = statement_timestamp()
         WHERE user_id = $1 AND attempt_id = $3`,
        [secondUserId, transactionId, secondAttemptId]
      );
    } catch (error) { duplicateTransactionError = error; }
    assert.equal(duplicateTransactionError?.code, '23505',
      'a transaction archived for one account must never be claimed by another current attempt');
    await client.query('ROLLBACK TO SAVEPOINT duplicate_archived_transaction');
    await client.query('RELEASE SAVEPOINT duplicate_archived_transaction');

    const ledgerTransactionId = `txn_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
    const firstLedgerEventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
    await client.query(
      "INSERT INTO paddle_webhook_events (event_id, event_type) VALUES ($1, 'transaction.completed')",
      [firstLedgerEventId]
    );
    await client.query(
      `INSERT INTO paddle_transaction_events
       (event_id, transaction_id, user_id, plan, status)
       VALUES ($1, $2, $3, '1month', 'completed')`,
      [firstLedgerEventId, ledgerTransactionId, firstUserId]
    );

    await client.query(
      "UPDATE users SET paddle_subscription_id = 'sub_0123456789abcdef01234567', paddle_customer_id = 'ctm_0123456789abcdef01234567' WHERE id = $1",
      [thirdUserId]
    );
    const paidTransactionId = `txn_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
    const subscriptionCreatedEventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
    await client.query(
      "INSERT INTO paddle_webhook_events (event_id, event_type) VALUES ($1, 'subscription.created')",
      [subscriptionCreatedEventId]
    );
    await client.query(
      `INSERT INTO paddle_transaction_events
       (event_id, transaction_id, user_id, plan, status, subscription_id, customer_id)
       VALUES ($1, $2, $3, '1month', 'paid', 'sub_0123456789abcdef01234567', 'ctm_0123456789abcdef01234567')`,
      [subscriptionCreatedEventId, paidTransactionId, thirdUserId]
    );
    const completedAfterPaidEventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
    await client.query(
      "INSERT INTO paddle_webhook_events (event_id, event_type) VALUES ($1, 'transaction.completed')",
      [completedAfterPaidEventId]
    );
    await client.query(
      `INSERT INTO paddle_transaction_events
       (event_id, transaction_id, user_id, plan, status, subscription_id, customer_id)
       VALUES ($1, $2, $3, '1month', 'completed', 'sub_0123456789abcdef01234567', 'ctm_0123456789abcdef01234567')`,
      [completedAfterPaidEventId, paidTransactionId, thirdUserId]
    );
    const lifecycleProgression = await client.query(
      'SELECT status FROM paddle_transaction_events WHERE transaction_id = $1 ORDER BY received_at, event_id',
      [paidTransactionId]
    );
    assert.deepEqual(lifecycleProgression.rows.map(row => row.status).sort(), ['completed', 'paid'],
      'Paddle captured payment may progress to completed without being mislabeled or treated as a contradiction');

    const secondLedgerEventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
    await client.query(
      "INSERT INTO paddle_webhook_events (event_id, event_type) VALUES ($1, 'transaction.completed')",
      [secondLedgerEventId]
    );
    await client.query('SAVEPOINT conflicting_transaction_ledger_owner');
    let conflictingLedgerOwnerError;
    try {
      await client.query(
        `INSERT INTO paddle_transaction_events
         (event_id, transaction_id, user_id, plan, status)
         VALUES ($1, $2, $3, '1month', 'completed')`,
        [secondLedgerEventId, ledgerTransactionId, secondUserId]
      );
    } catch (error) { conflictingLedgerOwnerError = error; }
    assert.equal(conflictingLedgerOwnerError?.code, '23505',
      'separate provider event IDs must not assign one Paddle transaction to two Vow accounts');
    await client.query('ROLLBACK TO SAVEPOINT conflicting_transaction_ledger_owner');
    await client.query('RELEASE SAVEPOINT conflicting_transaction_ledger_owner');

    const canceledEventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
    await client.query(
      "INSERT INTO paddle_webhook_events (event_id, event_type) VALUES ($1, 'transaction.canceled')",
      [canceledEventId]
    );
    await client.query('SAVEPOINT conflicting_transaction_lifecycle');
    let conflictingLifecycleError;
    try {
      await client.query(
        `INSERT INTO paddle_transaction_events
         (event_id, transaction_id, user_id, plan, status)
         VALUES ($1, $2, $3, '1month', 'canceled')`,
        [canceledEventId, ledgerTransactionId, firstUserId]
      );
    } catch (error) { conflictingLifecycleError = error; }
    assert.equal(conflictingLifecycleError?.code, '23505',
      'one provider transaction cannot be both completed and canceled');
    await client.query('ROLLBACK TO SAVEPOINT conflicting_transaction_lifecycle');
    await client.query('RELEASE SAVEPOINT conflicting_transaction_lifecycle');

    const conflictingAttemptId = randomUUID();
    await client.query(
      `INSERT INTO paddle_checkout_attempts
       (user_id, attempt_id, plan, status, created_at, updated_at)
       VALUES ($1, $2, '3months', 'creating', statement_timestamp(), statement_timestamp())`,
      [thirdUserId, conflictingAttemptId]
    );
    await client.query('SAVEPOINT conflicting_checkout_plan');
    let conflictingCheckoutPlanError;
    try {
      await client.query(
        `UPDATE paddle_checkout_attempts
         SET transaction_id = $2, status = 'completed', updated_at = statement_timestamp()
         WHERE user_id = $1 AND attempt_id = $3`,
        [thirdUserId, ledgerTransactionId, conflictingAttemptId]
      );
    } catch (error) { conflictingCheckoutPlanError = error; }
    assert.equal(conflictingCheckoutPlanError?.code, '23505',
      'a checkout must not claim a provider transaction recorded under a different plan');
    await client.query('ROLLBACK TO SAVEPOINT conflicting_checkout_plan');
    await client.query('RELEASE SAVEPOINT conflicting_checkout_plan');

    const mismatchedCustomerTransactionId = `txn_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
    const mismatchedCustomerEventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
    await client.query(
      "INSERT INTO paddle_webhook_events (event_id, event_type) VALUES ($1, 'transaction.completed')",
      [mismatchedCustomerEventId]
    );
    await client.query('SAVEPOINT mismatched_provider_customer_owner');
    let mismatchedProviderCustomerError;
    try {
      await client.query(
        `INSERT INTO paddle_transaction_events
         (event_id, transaction_id, user_id, plan, status, customer_id)
         VALUES ($1, $2, $3, 'lifetime', 'completed', $4)`,
        [mismatchedCustomerEventId, mismatchedCustomerTransactionId, firstUserId, secondCustomerId]
      );
    } catch (error) { mismatchedProviderCustomerError = error; }
    assert.equal(mismatchedProviderCustomerError?.code, '23505',
      'a completed transaction must not attach another account\'s Paddle customer ID to the checkout owner');
    await client.query('ROLLBACK TO SAVEPOINT mismatched_provider_customer_owner');
    await client.query('RELEASE SAVEPOINT mismatched_provider_customer_owner');

    const unboundCustomerTransactionId = `txn_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
    const unboundCustomerFirstEventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
    const unboundCustomerSecondEventId = `evt_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
    const firstUnboundCustomerId = 'ctm_4123456789abcdef01234567';
    const secondUnboundCustomerId = 'ctm_5123456789abcdef01234567';
    await client.query(
      "INSERT INTO paddle_webhook_events (event_id, event_type) VALUES ($1, 'transaction.completed'), ($2, 'transaction.completed')",
      [unboundCustomerFirstEventId, unboundCustomerSecondEventId]
    );
    await client.query(
      `INSERT INTO paddle_transaction_events
       (event_id, transaction_id, user_id, plan, status, customer_id)
       VALUES ($1, $2, $3, 'lifetime', 'completed', $4)`,
      [unboundCustomerFirstEventId, unboundCustomerTransactionId, firstUserId, firstUnboundCustomerId]
    );
    await client.query('SAVEPOINT conflicting_provider_customer_history');
    let conflictingProviderCustomerHistoryError;
    try {
      await client.query(
        `INSERT INTO paddle_transaction_events
         (event_id, transaction_id, user_id, plan, status, customer_id)
         VALUES ($1, $2, $3, 'lifetime', 'completed', $4)`,
        [unboundCustomerSecondEventId, unboundCustomerTransactionId, firstUserId, secondUnboundCustomerId]
      );
    } catch (error) { conflictingProviderCustomerHistoryError = error; }
    assert.equal(conflictingProviderCustomerHistoryError?.code, '23505',
      'all events for one Paddle transaction must retain the same customer identity even before it is linked to a user');
    await client.query('ROLLBACK TO SAVEPOINT conflicting_provider_customer_history');
    await client.query('RELEASE SAVEPOINT conflicting_provider_customer_history');

    const firstCustomerId = 'ctm_2123456789abcdef01234567';
    const secondCustomerId = 'ctm_3123456789abcdef01234567';
    await client.query(
      'UPDATE users SET paddle_customer_id = $2 WHERE id = $1',
      [firstUserId, firstCustomerId]
    );
    await client.query(
      'UPDATE users SET paddle_customer_id = $2 WHERE id = $1',
      [secondUserId, secondCustomerId]
    );

    const guardFunction = await client.query(
      "SELECT pg_get_functiondef('guard_paddle_checkout_transaction_global_uniqueness()'::regprocedure) AS definition"
    );
    assert.match(guardFunction.rows[0].definition, /paddle_checkout_attempt_history/);
    assert.match(guardFunction.rows[0].definition, /pg_advisory_xact_lock/,
      'cross-table transaction ownership checks must serialize concurrent claims until commit');
    assert.match(guardFunction.rows[0].definition,
      /pg_advisory_xact_lock\s*\(\s*hashtextextended\s*\(\s*'paddle-transaction:'/,
      'database ownership guard must use the same 64-bit transaction lock namespace as the webhook handlers');
    assert.match(guardFunction.rows[0].definition, /USING ERRCODE = '23505'/,
      'owner/plan/lifecycle collisions must be classified as identity conflicts for webhook reconciliation');
    assert.match(guardFunction.rows[0].definition, /completed\/canceled state/);
    const currentGuard = await client.query(
      "SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgname = 'paddle_checkout_attempts_global_transaction_identity' AND NOT tgisinternal"
    );
    assert.equal(currentGuard.rowCount, 1);
    assert.match(currentGuard.rows[0].definition, /UPDATE OF transaction_id, user_id, plan/,
      'changing a transaction-bearing checkout owner or plan must re-run the global identity guard');
    await client.query('ROLLBACK');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
});
