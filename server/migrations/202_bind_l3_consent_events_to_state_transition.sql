-- Bind each immutable consent event to the exact grant/withdrawal state
-- transition that produced it. Append-only alone is insufficient: otherwise a
-- caller could append a plausible event without changing current consent.
ALTER TABLE identity_l3_consents
  ADD COLUMN granted_txid BIGINT NOT NULL DEFAULT txid_current(),
  ADD COLUMN withdrawn_txid BIGINT;

UPDATE identity_l3_consents
SET withdrawn_txid = txid_current()
WHERE withdrawn_at IS NOT NULL;

CREATE OR REPLACE FUNCTION stamp_identity_l3_consent_transition_txid()
RETURNS trigger LANGUAGE plpgsql AS $l3_consent_transition_txid$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.granted_txid := txid_current();
    NEW.withdrawn_txid := NULL;
  ELSIF OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL THEN
    NEW.granted_txid := OLD.granted_txid;
    NEW.withdrawn_txid := txid_current();
  ELSIF NEW.withdrawn_at IS NULL
     AND (
       OLD.withdrawn_at IS NOT NULL
       OR NEW.consent_version IS DISTINCT FROM OLD.consent_version
       OR NEW.granted_at IS DISTINCT FROM OLD.granted_at
     ) THEN
    NEW.granted_txid := txid_current();
    NEW.withdrawn_txid := NULL;
  ELSE
    -- Ignore caller-supplied writes to the provenance columns when no consent
    -- transition is taking place.
    NEW.granted_txid := OLD.granted_txid;
    NEW.withdrawn_txid := OLD.withdrawn_txid;
  END IF;
  RETURN NEW;
END;
$l3_consent_transition_txid$;

CREATE TRIGGER identity_l3_consents_transition_txid
  BEFORE INSERT OR UPDATE ON identity_l3_consents
  FOR EACH ROW
  EXECUTE FUNCTION stamp_identity_l3_consent_transition_txid();

CREATE OR REPLACE FUNCTION require_identity_l3_consent_event_source()
RETURNS trigger LANGUAGE plpgsql AS $l3_consent_event_source$
BEGIN
  IF NEW.actor_user_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'identity L3 consent events must identify the consent owner as actor'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.event_type = 'granted' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM identity_l3_consents AS consent
      WHERE consent.user_id = NEW.user_id
        AND consent.consent_version = NEW.consent_version
        AND consent.granted_txid = txid_current()
        AND NEW.occurred_at >= consent.granted_at
        AND NEW.occurred_at <= statement_timestamp()
    ) THEN
      RAISE EXCEPTION 'L3 grant event must be emitted by a current grant transition in this transaction'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.event_type = 'withdrawn' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM identity_l3_consents AS consent
      WHERE consent.user_id = NEW.user_id
        AND consent.consent_version = NEW.consent_version
        AND consent.withdrawn_at IS NOT NULL
        AND consent.withdrawn_txid = txid_current()
        AND NEW.occurred_at >= consent.withdrawn_at
        AND NEW.occurred_at <= statement_timestamp()
    ) THEN
      RAISE EXCEPTION 'L3 withdrawal event must be emitted by a current withdrawal transition in this transaction'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported identity L3 consent event type'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$l3_consent_event_source$;

CREATE TRIGGER identity_l3_consent_events_source_guard
  BEFORE INSERT ON identity_l3_consent_events
  FOR EACH ROW
  EXECUTE FUNCTION require_identity_l3_consent_event_source();

COMMENT ON COLUMN identity_l3_consents.granted_txid IS
  'Database transaction ID of the current grant/notice-version transition; prevents standalone or stale grant audit events.';
COMMENT ON COLUMN identity_l3_consents.withdrawn_txid IS
  'Database transaction ID of the current withdrawal transition; prevents standalone or stale withdrawal audit events.';
COMMENT ON FUNCTION require_identity_l3_consent_event_source() IS
  'Allows consent events only when the current consent row proves the matching grant/withdrawal transition occurred in this same database transaction; rejects standalone and future-dated audit rows.';
