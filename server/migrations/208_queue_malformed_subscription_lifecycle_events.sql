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

CREATE OR REPLACE FUNCTION guard_paddle_adjustment_reconciliation_case()
RETURNS trigger LANGUAGE plpgsql AS $paddle_adjustment_case$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Paddle adjustment reconciliation evidence cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
     OR NEW.provider_subscription_id IS DISTINCT FROM OLD.provider_subscription_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Paddle adjustment reconciliation evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'resolved' THEN
    RAISE EXCEPTION 'resolved Paddle adjustment reconciliation cases are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'open' AND NEW.status = 'resolved') THEN
    RAISE EXCEPTION 'invalid Paddle adjustment reconciliation case transition'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'resolved' AND (
    NEW.resolution_note IS NULL OR length(btrim(NEW.resolution_note)) = 0
    OR length(NEW.resolution_note) > 1000 OR NEW.resolved_at IS NULL
    OR NEW.resolution_source IS NULL
    OR (NEW.resolution_source = 'manual_operator' AND NEW.resolved_by_ref IS NULL)
    OR (NEW.resolution_source = 'automatic_provider_transaction_link' AND NEW.resolved_by_ref IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'resolved Paddle adjustment cases require a bounded resolution note and timestamp'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$paddle_adjustment_case$;

COMMENT ON COLUMN paddle_adjustment_reconciliation_cases.provider_subscription_id IS
  'Immutable validated Paddle subscription identifier for manual lookup only; never sufficient to establish Vow account ownership or authorize an entitlement change.';
COMMENT ON COLUMN paddle_adjustment_reconciliation_cases.reason_code IS
  'Bounded reconciliation reason. Invalid transaction and subscription timestamps/identities are retained separately from lifecycle conflicts and cannot be auto-resolved without their respective verified evidence.';
