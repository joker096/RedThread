-- Keep a keyed, short-lived tombstone after account deletion so the same
-- normalized email cannot immediately recreate a fresh trial or reset quotas.
-- The email itself is never stored in this table.
CREATE TABLE IF NOT EXISTS account_reuse_restrictions (
  email_hmac CHAR(64) PRIMARY KEY
    CHECK (email_hmac ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS account_reuse_restrictions_expiry_idx
  ON account_reuse_restrictions (expires_at, email_hmac);
