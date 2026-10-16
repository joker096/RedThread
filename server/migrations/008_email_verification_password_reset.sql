ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS account_action_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('email_verification', 'password_reset')),
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS account_action_tokens_user_purpose_idx
  ON account_action_tokens (user_id, purpose, expires_at DESC)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS account_action_tokens_expiry_idx
  ON account_action_tokens (expires_at)
  WHERE consumed_at IS NULL;

COMMENT ON TABLE account_action_tokens IS
  'Single-use, expiring account action tokens. Only SHA-256 token hashes are stored.';
COMMENT ON COLUMN users.email_verified_at IS
  'Timestamp of email verification. NULL means the account email has not been verified.';
