-- Support the worker's due-attempt scan by retry time, then age.
-- Partial predicate keeps terminal attempts out of the scheduling index.
CREATE INDEX IF NOT EXISTS paddle_checkout_attempts_recovery_due_schedule_idx
  ON paddle_checkout_attempts (recovery_next_attempt_at, created_at)
  WHERE status = 'creating';
