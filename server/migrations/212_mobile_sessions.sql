CREATE TABLE IF NOT EXISTS mobile_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
  device_id UUID NOT NULL,
  device_name TEXT NOT NULL CHECK (length(device_name) BETWEEN 1 AND 80),
  access_token_hash CHAR(64) NOT NULL UNIQUE CHECK (access_token_hash ~ '^[a-f0-9]{64}$'),
  refresh_token_hash CHAR(64) NOT NULL UNIQUE CHECK (refresh_token_hash ~ '^[a-f0-9]{64}$'),
  access_expires_at TIMESTAMPTZ NOT NULL,
  refresh_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT CHECK (revoked_reason IS NULL OR revoked_reason IN ('logout', 'refresh_reuse', 'account_security', 'password_reset', 'account_unavailable')),
  CHECK (access_expires_at <= refresh_expires_at),
  CHECK (rotated_at IS NULL OR rotated_at >= created_at),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

CREATE INDEX IF NOT EXISTS mobile_sessions_user_active_idx
  ON mobile_sessions (user_id, last_seen_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS mobile_sessions_refresh_expiry_idx
  ON mobile_sessions (refresh_expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS mobile_refresh_token_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES mobile_sessions(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mobile_refresh_token_history_session_idx
  ON mobile_refresh_token_history (session_id, consumed_at DESC);

CREATE OR REPLACE FUNCTION prevent_mobile_refresh_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'mobile refresh token history is append-only';
END;
$$;

DROP TRIGGER IF EXISTS mobile_refresh_token_history_no_update ON mobile_refresh_token_history;
CREATE TRIGGER mobile_refresh_token_history_no_update
  BEFORE UPDATE ON mobile_refresh_token_history
  FOR EACH ROW EXECUTE FUNCTION prevent_mobile_refresh_history_mutation();
