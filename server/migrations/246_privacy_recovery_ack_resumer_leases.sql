-- Lease-based delivery repair for persisted privacy Ledger intents.
-- A worker claims rows in a short transaction and performs the HTTP request
-- only after that transaction has committed and all row locks are released.
ALTER TABLE privacy_recovery_operations
  ADD COLUMN IF NOT EXISTS ack_lease_token UUID,
  ADD COLUMN IF NOT EXISTS ack_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ack_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ack_next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  ADD COLUMN IF NOT EXISTS ack_last_error_code TEXT;

ALTER TABLE privacy_recovery_operations
  ADD CONSTRAINT privacy_recovery_ack_lease_pair_check
    CHECK ((ack_lease_token IS NULL) = (ack_lease_expires_at IS NULL)),
  ADD CONSTRAINT privacy_recovery_ack_attempts_check
    CHECK (ack_attempts >= 0),
  ADD CONSTRAINT privacy_recovery_ack_error_code_check
    CHECK (ack_last_error_code IS NULL OR length(ack_last_error_code) BETWEEN 1 AND 96);

CREATE INDEX IF NOT EXISTS privacy_recovery_operations_ack_due_idx
  ON privacy_recovery_operations (ack_next_attempt_at, created_at, operation_id)
  WHERE status = 'pending';
