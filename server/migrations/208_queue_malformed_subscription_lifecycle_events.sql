-- Retain malformed Paddle subscription lifecycle webhooks in the same durable
-- reconciliation queue as transaction evidence. The provider subscription ID
-- is an immutable lookup key only; it is not proof of account ownership.
ALTER TABLE paddle_adjustment_reconciliation_cases
  ADD COLUMN provider_subscription_id TEXT;

ALTER TABLE paddle_adjustment_reconciliation_cases
  ADD CONSTRAINT paddle_adjustment_reconciliation_subscription_id_check
  CHECK (
    provider_subscription_id IS NULL
    OR provider_subscription_id ~ '^sub_[A-Za-z0-9]+$'
  );

ALTER TABLE paddle_adjustment_reconciliation_cases
  DROP CONSTRAINT IF EXISTS paddle_adjustment_reconciliation_cases_reason_code_check;

ALTER TABLE paddle_adjustment_reconciliation_cases
  ADD CONSTRAINT paddle_adjustment_reconciliation_cases_reason_code_check
  CHECK (reason_code IN (
    'invalid_adjustment_payload',
    'transaction_owner_unlinked',
    'transaction_owner_ambiguous',
    'lifetime_account_inactive',
    'lifetime_entitlement_missing',
    'provider_identity_conflict',
    'provider_lifecycle_conflict',
    'invalid_transaction_timestamp',
    'invalid_subscription_timestamp',
    'invalid_subscription_identity'
  ));

CREATE OR REPLACE FUNCTION guard_paddle_reconciliation_subscription_identity()
RETURNS trigger LANGUAGE plpgsql AS $subscription_identity$
BEGIN
  IF NEW.provider_subscription_id IS DISTINCT FROM OLD.provider_subscription_id THEN
    RAISE EXCEPTION 'Paddle reconciliation source evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$subscription_identity$;

CREATE TRIGGER paddle_adjustment_reconciliation_subscription_identity_guard
  BEFORE UPDATE OF provider_subscription_id ON paddle_adjustment_reconciliation_cases
  FOR EACH ROW EXECUTE FUNCTION guard_paddle_reconciliation_subscription_identity();

COMMENT ON COLUMN paddle_adjustment_reconciliation_cases.provider_subscription_id IS
  'Immutable validated Paddle subscription identifier for manual lookup only; never sufficient to establish Vow account ownership or authorize an entitlement change.';
COMMENT ON COLUMN paddle_adjustment_reconciliation_cases.reason_code IS
  'Bounded reconciliation reason. Invalid transaction and subscription timestamps/identities are retained separately from lifecycle conflicts and cannot be auto-resolved without their respective verified evidence.';
\n-- Extend the existing audited manual-closure policy without weakening its\n-- provider evidence, moderator role, or immutable audit matching requirements.\n-- A malformed adjustment event that could not be written to the ledger must
-- remain open until a later signed event proves the same provider adjustment.
-- If the provider adjustment ID is absent/invalid, there is no safe correlation
-- key and the case cannot be manually dismissed.
-- Preserve webhook write lock order to avoid deadlocks with event ingestion.
LOCK TABLE paddle_adjustment_events, paddle_adjustment_reconciliation_cases
  IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION require_manual_paddle_adjustment_resolution_audit()
RETURNS trigger LANGUAGE plpgsql AS $manual_adjustment_audit$
BEGIN
  IF NEW.status = 'resolved' AND NEW.resolution_source = 'manual_operator'
     AND (
       NEW.reason_code NOT IN (
         'invalid_adjustment_payload',
         'provider_identity_conflict',
         'provider_lifecycle_conflict',
         'invalid_subscription_timestamp',
         'invalid_subscription_identity'
       )
       OR NOT EXISTS (
         SELECT 1 FROM paddle_webhook_events AS webhook
         WHERE webhook.event_id = NEW.event_id
           AND (
             webhook.event_type IN (
               'adjustment.created', 'adjustment.updated',
               'customer.created', 'customer.updated'
             )
             OR (
               NEW.reason_code IN ('invalid_subscription_timestamp', 'invalid_subscription_identity')
               AND webhook.event_type IN (
                 'subscription.created', 'subscription.updated', 'subscription.canceled'
               )
             )
           )
       )
       OR (
         NEW.reason_code = 'invalid_subscription_timestamp'
         AND NEW.provider_subscription_id IS NULL
       )
       OR (
         NEW.reason_code = 'invalid_adjustment_payload'
         AND EXISTS (
           SELECT 1 FROM paddle_webhook_events AS webhook
           WHERE webhook.event_id = NEW.event_id
             AND webhook.event_type IN ('adjustment.created', 'adjustment.updated')
         )
         AND NOT EXISTS (
           SELECT 1 FROM paddle_adjustment_events AS source
           WHERE source.event_id = NEW.event_id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM paddle_adjustment_events AS verified_adjustment
           JOIN paddle_webhook_events AS verified_webhook
             ON verified_webhook.event_id = verified_adjustment.event_id
            AND verified_webhook.event_type IN ('adjustment.created', 'adjustment.updated')
           JOIN paddle_webhook_events AS original_webhook
             ON original_webhook.event_id = NEW.event_id
           WHERE verified_adjustment.adjustment_id = NEW.provider_adjustment_id
             AND verified_webhook.processed_at > original_webhook.processed_at
             AND NEW.provider_adjustment_id IS NOT NULL
             AND (NEW.provider_transaction_id IS NULL
               OR verified_adjustment.transaction_id = NEW.provider_transaction_id)
             AND verified_adjustment.event_id <> NEW.event_id
             AND (verified_adjustment.action <> 'refund'
               OR verified_adjustment.adjustment_type IN ('full', 'partial'))
         )
       )
       OR (
         NEW.reason_code = 'invalid_adjustment_payload'
         AND EXISTS (
           SELECT 1
           FROM paddle_adjustment_events AS source
           WHERE source.event_id = NEW.event_id
             AND source.action = 'refund'
             AND source.adjustment_type IS NULL
         )
         AND NOT EXISTS (
           SELECT 1
           FROM paddle_adjustment_events AS source
           JOIN paddle_adjustment_events AS verified_scope
             ON verified_scope.adjustment_id = source.adjustment_id
           JOIN paddle_webhook_events AS verified_webhook
             ON verified_webhook.event_id = verified_scope.event_id
            AND verified_webhook.event_type IN ('adjustment.created', 'adjustment.updated')
           JOIN paddle_webhook_events AS original_webhook
             ON original_webhook.event_id = source.event_id
            AND verified_webhook.processed_at > original_webhook.processed_at
            AND verified_scope.transaction_id = source.transaction_id
            AND verified_scope.action = 'refund'
            AND verified_scope.adjustment_type IN ('full', 'partial')
           WHERE source.event_id = NEW.event_id
             AND source.action = 'refund'
         )
       )
       OR NOT EXISTS (
         SELECT 1 FROM users AS moderator
         WHERE moderator.id = NEW.resolved_by_ref
           AND moderator.status = 'active'
           AND moderator.role IN ('admin', 'moderator')
       )
       OR NOT EXISTS (
         SELECT 1
         FROM moderation_audit_log AS audit
         WHERE audit.action = 'paddle_adjustment_reconciliation_resolved'
           AND audit.target_type = 'paddle_adjustment_case'
           AND audit.target_id = NEW.event_id
           AND audit.reason = NEW.resolution_note
           AND audit.moderator_ref = NEW.resolved_by_ref
           AND audit.details->>'eventId' = NEW.event_id
           AND audit.details->>'reasonCode' = NEW.reason_code
           AND audit.details->>'resolutionSource' = 'manual_operator'
           AND audit.details->>'adjustmentId' IS NOT DISTINCT FROM
             COALESCE(
               NEW.provider_adjustment_id,
               (SELECT source.adjustment_id FROM paddle_adjustment_events AS source
                WHERE source.event_id = NEW.event_id)
             )
           AND audit.details->>'transactionId' IS NOT DISTINCT FROM
             COALESCE(
               NEW.provider_transaction_id,
               (SELECT source.transaction_id FROM paddle_adjustment_events AS source
                WHERE source.event_id = NEW.event_id)
             )
           AND audit.details->>'providerUserRef' IS NOT DISTINCT FROM NEW.provider_user_ref::text
           AND audit.details->>'providerPlan' IS NOT DISTINCT FROM NEW.provider_plan
           AND audit.details->>'providerSubscriptionId' IS NOT DISTINCT FROM NEW.provider_subscription_id
       )
     ) THEN
    RAISE EXCEPTION 'manual Paddle resolution requires later verified adjustment evidence, verified refund scope and matching moderator audit evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$manual_adjustment_audit$;

COMMENT ON FUNCTION require_manual_paddle_adjustment_resolution_audit() IS
  'Malformed adjustment events without a source ledger row remain open until a later signed provider event proves the same immutable adjustment identity; missing adjustment IDs cannot be manually dismissed. Refunds with unknown scope also remain open until a later signed event supplies full/partial scope. All manual closures require matching immutable moderator audit evidence.';
