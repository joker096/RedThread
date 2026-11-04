-- Bind each consent audit event to the database transaction that wrote it.
-- A future-dated append-only event from an earlier transaction must not be
-- reusable to authorize a later grant/withdrawal state mutation.
ALTER TABLE identity_l3_consent_events
  ADD COLUMN recorded_txid BIGINT NOT NULL DEFAULT txid_current();

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
      AND event.occurred_at >= expected_occurred_at
      AND event.recorded_txid = txid_current()
  ) THEN
    RAISE EXCEPTION 'identity L3 consent state transition requires a matching append-only audit event in the same transaction'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$l3_consent_event_guard$;

COMMENT ON COLUMN identity_l3_consent_events.recorded_txid IS
  'Database transaction ID that inserted the immutable consent event; prevents a previously committed or future-dated event from authorizing a later state transition.';
