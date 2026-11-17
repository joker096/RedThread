-- Durable bounded recovery leases for orphaned Paddle checkout attempts.
ALTER TABLE paddle_checkout_attempts
  ADD COLUMN IF NOT EXISTS recovery_lease_token UUID,
  ADD COLUMN IF NOT EXISTS recovery_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recovery_attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recovery_last_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recovery_next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS recovery_last_error_code TEXT;

ALTER TABLE paddle_checkout_attempts
  ADD CONSTRAINT paddle_checkout_attempts_recovery_attempt_count_check
    CHECK (recovery_attempt_count >= 0),
  ADD CONSTRAINT paddle_checkout_attempts_recovery_lease_pair_check
    CHECK ((recovery_lease_token IS NULL) = (recovery_lease_expires_at IS NULL));

CREATE INDEX IF NOT EXISTS paddle_checkout_attempts_recovery_due_idx
  ON paddle_checkout_attempts (created_at, updated_at)
  WHERE status = 'creating';
