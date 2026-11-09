CREATE TABLE IF NOT EXISTS mobile_push_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES mobile_sessions(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
  token_fingerprint CHAR(64) NOT NULL UNIQUE CHECK (token_fingerprint ~ '^[a-f0-9]{64}$'),
  token_ciphertext BYTEA NOT NULL CHECK (octet_length(token_ciphertext) BETWEEN 40 AND 8192),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT CHECK (revoked_reason IS NULL OR revoked_reason IN (
    'logout', 'refresh_reuse', 'account_security', 'password_reset',
    'account_unavailable', 'permission_revoked', 'token_rotated', 'session_revoked'
  )),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS mobile_push_tokens_one_active_session_uidx
  ON mobile_push_tokens (session_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS mobile_push_tokens_user_active_idx
  ON mobile_push_tokens (user_id, platform)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS mobile_push_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL REFERENCES user_notifications(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_id UUID NOT NULL REFERENCES mobile_push_tokens(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('new_match', 'new_message', 'gift_request', 'gift_request_update')),
  deep_link TEXT NOT NULL CHECK (deep_link IN ('/chats', '/gifts', '/discovery')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'retry', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 100),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_expires_at TIMESTAMPTZ,
  provider_message_id TEXT CHECK (provider_message_id IS NULL OR length(provider_message_id) <= 256),
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) <= 80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  UNIQUE (notification_id, token_id),
  CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS mobile_push_outbox_due_idx
  ON mobile_push_outbox (next_attempt_at, created_at)
  WHERE status IN ('pending', 'retry');

CREATE INDEX IF NOT EXISTS mobile_push_outbox_lease_idx
  ON mobile_push_outbox (lease_expires_at)
  WHERE status = 'processing';

CREATE OR REPLACE FUNCTION revoke_mobile_push_tokens_for_revoked_session()
RETURNS trigger
LANGUAGE plpgsql
AS $revoke_mobile_push_tokens$
BEGIN
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    UPDATE mobile_push_tokens
    SET revoked_at = NEW.revoked_at,
        revoked_reason = CASE
          WHEN NEW.revoked_reason IN ('logout', 'refresh_reuse', 'account_security', 'password_reset', 'account_unavailable')
          THEN NEW.revoked_reason
          ELSE 'session_revoked'
        END,
        updated_at = NEW.revoked_at
    WHERE session_id = NEW.id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$revoke_mobile_push_tokens$;

DROP TRIGGER IF EXISTS mobile_push_tokens_revoke_with_session ON mobile_sessions;
CREATE TRIGGER mobile_push_tokens_revoke_with_session
  AFTER UPDATE OF revoked_at ON mobile_sessions
  FOR EACH ROW EXECUTE FUNCTION revoke_mobile_push_tokens_for_revoked_session();
