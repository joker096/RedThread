CREATE TABLE IF NOT EXISTS profile_voice_intro_consents (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  consent_version INTEGER NOT NULL CHECK (consent_version > 0),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  withdrawn_at TIMESTAMPTZ,
  granted_txid BIGINT,
  withdrawn_txid BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT profile_voice_intro_consents_withdrawal_check
    CHECK (withdrawn_at IS NULL OR withdrawn_at >= granted_at)
);

CREATE TABLE IF NOT EXISTS profile_voice_intro_consent_events (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('granted', 'withdrawn')),
  consent_version INTEGER NOT NULL CHECK (consent_version > 0),
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_txid BIGINT NOT NULL DEFAULT txid_current()
);

CREATE INDEX IF NOT EXISTS profile_voice_intro_consent_events_user_idx
  ON profile_voice_intro_consent_events (user_id, occurred_at, id);

-- Existing voice clips predate explicit, versioned consent. They must not remain
-- available or retained as if the new consent had been granted retroactively.
INSERT INTO private_voice_intro_purge_queue (storage_path)
SELECT storage_path FROM profile_voice_intros
ON CONFLICT (storage_path) DO NOTHING;
DELETE FROM profile_voice_intros;

CREATE OR REPLACE FUNCTION stamp_profile_voice_intro_consent_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.granted_at IS DISTINCT FROM OLD.granted_at THEN
    NEW.granted_txid := txid_current();
  END IF;
  IF TG_OP = 'INSERT' OR NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at THEN
    NEW.withdrawn_txid := CASE WHEN NEW.withdrawn_at IS NULL THEN NULL ELSE txid_current() END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profile_voice_intro_consents_transition_txid
  ON profile_voice_intro_consents;
CREATE TRIGGER profile_voice_intro_consents_transition_txid
  BEFORE INSERT OR UPDATE ON profile_voice_intro_consents
  FOR EACH ROW EXECUTE FUNCTION stamp_profile_voice_intro_consent_transition();

CREATE OR REPLACE FUNCTION validate_profile_voice_intro_consent_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  consent_state profile_voice_intro_consents%ROWTYPE;
BEGIN
  NEW.recorded_txid := txid_current();
  SELECT * INTO consent_state
  FROM profile_voice_intro_consents
  WHERE user_id = NEW.user_id;
  IF NOT FOUND OR consent_state.consent_version <> NEW.consent_version OR
     NEW.actor_user_id <> NEW.user_id THEN
    RAISE EXCEPTION 'profile voice intro consent event does not match current consent state'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.event_type = 'granted' THEN
    IF consent_state.withdrawn_at IS NOT NULL OR
       consent_state.granted_txid <> txid_current() OR
       consent_state.granted_at IS DISTINCT FROM NEW.occurred_at THEN
      RAISE EXCEPTION 'profile voice intro grant event must match a grant in this transaction'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.event_type = 'withdrawn' THEN
    IF consent_state.withdrawn_at IS NULL OR
       consent_state.withdrawn_txid <> txid_current() OR
       consent_state.withdrawn_at IS DISTINCT FROM NEW.occurred_at THEN
      RAISE EXCEPTION 'profile voice intro withdrawal event must match a withdrawal in this transaction'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profile_voice_intro_consent_events_validate
  ON profile_voice_intro_consent_events;
CREATE TRIGGER profile_voice_intro_consent_events_validate
  BEFORE INSERT ON profile_voice_intro_consent_events
  FOR EACH ROW EXECUTE FUNCTION validate_profile_voice_intro_consent_event();

CREATE OR REPLACE FUNCTION require_profile_voice_intro_consent_transition_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.granted_txid = txid_current() AND NOT EXISTS (
    SELECT 1 FROM profile_voice_intro_consent_events e
    WHERE e.user_id = NEW.user_id AND e.event_type = 'granted'
      AND e.consent_version = NEW.consent_version
      AND e.occurred_at = NEW.granted_at AND e.recorded_txid = txid_current()
  ) THEN
    RAISE EXCEPTION 'profile voice intro grant requires a same-transaction consent event'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.withdrawn_txid = txid_current() AND NOT EXISTS (
    SELECT 1 FROM profile_voice_intro_consent_events e
    WHERE e.user_id = NEW.user_id AND e.event_type = 'withdrawn'
      AND e.consent_version = NEW.consent_version
      AND e.occurred_at = NEW.withdrawn_at AND e.recorded_txid = txid_current()
  ) THEN
    RAISE EXCEPTION 'profile voice intro withdrawal requires a same-transaction consent event'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS profile_voice_intro_consents_require_event
  ON profile_voice_intro_consents;
CREATE CONSTRAINT TRIGGER profile_voice_intro_consents_require_event
  AFTER INSERT OR UPDATE ON profile_voice_intro_consents
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_profile_voice_intro_consent_transition_event();

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
  'Append-only voice introduction consent history. Each event must match a same-transaction state transition; events may be purged only after account deletion.';
