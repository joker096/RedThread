-- Give every newly-created checkout attempt an immutable identity that is
-- copied into Paddle custom_data. This prevents delayed provider events from
-- claiming a later attempt for the same user and plan while transaction_id is
-- still NULL. Existing attempts remain NULL and use exact transaction-ID
-- matching for backward compatibility.
ALTER TABLE paddle_checkout_attempts
  ADD COLUMN IF NOT EXISTS attempt_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS paddle_checkout_attempts_attempt_id_unique
  ON paddle_checkout_attempts (attempt_id)
  WHERE attempt_id IS NOT NULL;

COMMENT ON COLUMN paddle_checkout_attempts.attempt_id IS
  'Server-generated immutable ID copied into Paddle custom_data to bind webhooks to exactly one checkout attempt; NULL only for legacy attempts created before migration 105.';
