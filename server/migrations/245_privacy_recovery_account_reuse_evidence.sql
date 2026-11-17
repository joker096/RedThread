-- Preserve a non-reversible proof of the 90-day account-reuse restriction.
-- The value is the existing keyed HMAC, never the normalized email.
ALTER TABLE privacy_recovery_replay_effects
  ADD COLUMN IF NOT EXISTS account_reuse_hmac TEXT
  CHECK (account_reuse_hmac IS NULL OR account_reuse_hmac ~ '^[a-fA-F0-9]{64}$');

ALTER TABLE privacy_recovery_replay_effects
  DROP CONSTRAINT IF EXISTS privacy_recovery_replay_effects_account_reuse_scope_check;
ALTER TABLE privacy_recovery_replay_effects
  ADD CONSTRAINT privacy_recovery_replay_effects_account_reuse_scope_check
  CHECK (
    (event_type = 'account_erasure_requested' AND account_reuse_hmac IS NOT NULL)
    OR (event_type <> 'account_erasure_requested' AND account_reuse_hmac IS NULL)
  );

COMMENT ON COLUMN privacy_recovery_replay_effects.account_reuse_hmac IS
  'Keyed email-reuse restriction digest for account erasure verification; never stores the email or an unkeyed email hash.';
