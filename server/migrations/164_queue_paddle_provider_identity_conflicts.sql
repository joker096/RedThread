-- The existing moderator reconciliation queue is also the durable queue for
-- provider identity/lifecycle collisions that cannot safely be auto-applied.
-- Keep old adjustment reason codes stable and add explicit bounded categories.
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
    'provider_lifecycle_conflict'
  ));

COMMENT ON TABLE paddle_adjustment_reconciliation_cases IS
  'Durable moderator queue for Paddle adjustment and provider identity/lifecycle reconciliation. Keyed by immutable webhook event ID; stores bounded reason codes and no provider payloads or payment credentials.';
