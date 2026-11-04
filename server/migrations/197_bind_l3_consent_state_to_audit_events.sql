-- Reconstruct missing historical consent events before enforcing that every
-- current-state transition has a matching append-only audit record.
INSERT INTO identity_l3_consent_events
  (user_id, actor_user_id, event_type, consent_version, occurred_at)
SELECT consent.user_id, consent.user_id, 'granted', consent.consent_version, consent.granted_at
FROM identity_l3_consents AS consent
WHERE NOT EXISTS (
  SELECT 1
  FROM identity_l3_consent_events AS event
  WHERE event.user_id = consent.user_id
    AND event.event_type = 'granted'
    AND event.consent_version = consent.consent_version
    AND event.occurred_at = consent.granted_at
);

INSERT INTO identity_l3_consent_events
  (user_id, actor_user_id, event_type, consent_version, occurred_at)
SELECT consent.user_id, consent.user_id, 'withdrawn', consent.consent_version, consent.withdrawn_at
FROM identity_l3_consents AS consent
WHERE consent.withdrawn_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM identity_l3_consent_events AS event
    WHERE event.user_id = consent.user_id
      AND event.event_type = 'withdrawn'
      AND event.consent_version = consent.consent_version
      AND event.occurred_at = consent.withdrawn_at
  );

CREATE OR REPLACE FUNCTION guard_identity_l3_consent_state()
RETURNS trigger LANGUAGE plpgsql AS $l3_consent_state_guard$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'identity L3 consent ownership is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL THEN
    IF NEW.consent_version IS DISTINCT FROM OLD.consent_version
       OR NEW.granted_at IS DISTINCT FROM OLD.granted_at
       OR NEW.withdrawn_at <= OLD.granted_at THEN
      RAISE EXCEPTION 'identity L3 withdrawal must preserve the granted consent version and timestamp'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.withdrawn_at IS NULL
     AND (
       OLD.withdrawn_at IS NOT NULL
       OR NEW.consent_version IS DISTINCT FROM OLD.consent_version
       OR NEW.granted_at IS DISTINCT FROM OLD.granted_at
     ) THEN
    IF NEW.granted_at IS NULL
       OR NEW.granted_at <= OLD.granted_at
       OR (OLD.withdrawn_at IS NOT NULL AND NEW.granted_at <= OLD.withdrawn_at) THEN
      RAISE EXCEPTION 'identity L3 re-consent requires a new grant timestamp after the previous grant/withdrawal'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at
     OR NEW.consent_version IS DISTINCT FROM OLD.consent_version
     OR NEW.granted_at IS DISTINCT FROM OLD.granted_at THEN
    RAISE EXCEPTION 'identity L3 consent state may change only through a new grant or one-way withdrawal'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$l3_consent_state_guard$;

CREATE TRIGGER identity_l3_consents_state_guard
  BEFORE UPDATE ON identity_l3_consents
  FOR EACH ROW
  EXECUTE FUNCTION guard_identity_l3_consent_state();

CREATE OR REPLACE FUNCTION require_identity_l3_consent_state_audit_event()
RETURNS trigger LANGUAGE plpgsql AS $l3_consent_event_guard$
DECLARE
  expected_event_type TEXT;
  expected_version SMALLINT;
  expected_occurred_at TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'INSERT' THEN
    expected_event_type := 'granted';
    expected_version := NEW.consent_version;
    expected_occurred_at := NEW.granted_at;
  ELSIF OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL THEN
    expected_event_type := 'withdrawn';
    expected_version := OLD.consent_version;
    expected_occurred_at := NEW.withdrawn_at;
  ELSIF NEW.withdrawn_at IS NULL
     AND (
       OLD.withdrawn_at IS NOT NULL
       OR NEW.consent_version IS DISTINCT FROM OLD.consent_version
       OR NEW.granted_at IS DISTINCT FROM OLD.granted_at
     ) THEN
    expected_event_type := 'granted';
    expected_version := NEW.consent_version;
    expected_occurred_at := NEW.granted_at;
  ELSE
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM identity_l3_consent_events AS event
    WHERE event.user_id = NEW.user_id
      AND event.actor_user_id = NEW.user_id
      AND event.event_type = expected_event_type
      AND event.consent_version = expected_version
      AND event.occurred_at = expected_occurred_at
  ) THEN
    RAISE EXCEPTION 'identity L3 consent state transition requires a matching append-only audit event'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$l3_consent_event_guard$;

CREATE CONSTRAINT TRIGGER identity_l3_consents_require_audit_event
  AFTER INSERT OR UPDATE ON identity_l3_consents
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION require_identity_l3_consent_state_audit_event();

COMMENT ON FUNCTION guard_identity_l3_consent_state() IS
  'Freezes consent ownership and allows only a one-way withdrawal or a fresh grant/notice acceptance with a later granted_at timestamp.';
COMMENT ON FUNCTION require_identity_l3_consent_state_audit_event() IS
  'Requires each inserted, re-granted, version-updated or withdrawn current-consent row to have the exact matching immutable consent event in the same transaction.';
