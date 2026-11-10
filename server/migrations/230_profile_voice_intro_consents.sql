CREATE TABLE IF NOT EXISTS profile_voice_intro_consents (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  consent_version INTEGER NOT NULL CHECK (consent_version > 0),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  withdrawn_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT profile_voice_intro_consents_withdrawal_check
    CHECK (withdrawn_at IS NULL OR withdrawn_at >= granted_at)
);

CREATE TABLE IF NOT EXISTS profile_voice_intro_consent_events (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('granted', 'withdrawn')),
  consent_version INTEGER NOT NULL CHECK (consent_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);

CREATE INDEX IF NOT EXISTS profile_voice_intro_consent_events_user_idx
  ON profile_voice_intro_consent_events (user_id, created_at, id);

CREATE OR REPLACE FUNCTION protect_profile_voice_intro_consent_events()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (
    SELECT 1 FROM users WHERE id = OLD.user_id AND status = 'deleted'
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'profile voice intro consent events are immutable'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS profile_voice_intro_consent_events_immutable
  ON profile_voice_intro_consent_events;
CREATE TRIGGER profile_voice_intro_consent_events_immutable
  BEFORE UPDATE OR DELETE ON profile_voice_intro_consent_events
  FOR EACH ROW EXECUTE FUNCTION protect_profile_voice_intro_consent_events();

COMMENT ON TABLE profile_voice_intro_consents IS
  'Current versioned consent state for collecting, moderating, storing and showing a profile voice introduction.';
COMMENT ON TABLE profile_voice_intro_consent_events IS
  'Append-only voice introduction consent history. Events may be purged only after the account is tombstoned as deleted.';
