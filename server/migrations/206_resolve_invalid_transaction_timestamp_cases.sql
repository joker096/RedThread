-- Separate malformed transaction chronology from genuine provider lifecycle conflicts.
-- A timestamp-invalid transaction webhook is retained without a lifecycle row;
-- it may be auto-resolved only after a later, timestamp-valid completed/canceled
-- event proves the same transaction and a unique checkout/subscription owner.
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
    'invalid_transaction_timestamp'
  ));

COMMENT ON COLUMN paddle_adjustment_reconciliation_cases.reason_code IS
  'Bounded reconciliation reason. invalid_transaction_timestamp is distinct from a genuine lifecycle contradiction and can close only after later verified transaction evidence establishes the same transaction and unique owner.';
