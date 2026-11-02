-- Explicit, versioned consent is a hard prerequisite for every L3 upload capability.
-- A missing row is equivalent to no consent. Withdrawals are durable and auditable.
CREATE TABLE identity_l3_consents (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  consent_version INTEGER NOT NULL CHECK (consent_version > 0),
  granted_at TIMESTAMPTZ NOT NULL,
  withdrawn_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CHECK (withdrawn_at IS NULL OR withdrawn_at >= granted_at)
);

CREATE TABLE identity_l3_consent_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id UUID,
  event_type TEXT NOT NULL CHECK (event_type IN ('granted', 'withdrawn')),
  consent_version INTEGER NOT NULL CHECK (consent_version > 0),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CHECK (actor_user_id IS NULL OR actor_user_id = user_id)
);

CREATE INDEX identity_l3_consent_events_user_idx
  ON identity_l3_consent_events(user_id, occurred_at DESC, id);

CREATE OR REPLACE FUNCTION prevent_identity_l3_consent_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $l3_consent_audit$
BEGIN
  -- Permit only referential cleanup from a cascading account deletion.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'identity L3 consent events are append-only'
    USING ERRCODE = '55000';
END;
$l3_consent_audit$;

CREATE TRIGGER identity_l3_consent_events_append_only
  BEFORE UPDATE OR DELETE ON identity_l3_consent_events
  FOR EACH ROW EXECUTE FUNCTION prevent_identity_l3_consent_event_mutation();

COMMENT ON TABLE identity_l3_consents IS
  'Current explicit L3 video-processing consent. Upload authorization requires the current version and withdrawn_at IS NULL.';
COMMENT ON TABLE identity_l3_consent_events IS
  'Append-only audit of explicit L3 video-processing consent grants and withdrawals; no biometric payloads or free-form personal data.';
