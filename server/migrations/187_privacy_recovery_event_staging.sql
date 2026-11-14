-- Stage authenticated off-host privacy events alongside a restored snapshot.
-- This table is an immutable import ledger only; it does not itself apply domain actions.
CREATE TABLE IF NOT EXISTS privacy_recovery_events (
  ledger_sequence BIGINT PRIMARY KEY CHECK (ledger_sequence > 0),
  event_id UUID NOT NULL UNIQUE,
  schema_version SMALLINT NOT NULL CHECK (schema_version = 1),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'account_erasure_requested',
    'voice_intro_consent_withdrawn',
    'voice_intro_erasure_requested',
    'private_photo_erasure_requested',
    'identity_l3_consent_withdrawn',
    'ad_consent_revoked',
    'gift_order_consent_withdrawn'
  )),
  subject_ref CHAR(64) NOT NULL CHECK (subject_ref ~ '^[a-fA-F0-9]{64}$'),
  resource_ref CHAR(64) CHECK (resource_ref IS NULL OR resource_ref ~ '^[a-fA-F0-9]{64}$'),
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);

CREATE INDEX IF NOT EXISTS privacy_recovery_events_subject_sequence_idx
  ON privacy_recovery_events(subject_ref, ledger_sequence);

CREATE OR REPLACE FUNCTION prevent_privacy_recovery_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $privacy_recovery_immutable$
BEGIN
  RAISE EXCEPTION 'staged privacy recovery events are immutable'
    USING ERRCODE = '55000';
END;
$privacy_recovery_immutable$;

DROP TRIGGER IF EXISTS privacy_recovery_events_no_update ON privacy_recovery_events;
CREATE TRIGGER privacy_recovery_events_no_update
  BEFORE UPDATE ON privacy_recovery_events
  FOR EACH ROW EXECUTE FUNCTION prevent_privacy_recovery_event_mutation();

DROP TRIGGER IF EXISTS privacy_recovery_events_no_delete ON privacy_recovery_events;
CREATE TRIGGER privacy_recovery_events_no_delete
  BEFORE DELETE ON privacy_recovery_events
  FOR EACH ROW EXECUTE FUNCTION prevent_privacy_recovery_event_mutation();

COMMENT ON TABLE privacy_recovery_events IS
  'Immutable staging copy of off-host privacy ledger events newer than a restored backup watermark. Importing is not replay; restored services remain isolated until domain-specific application and verification are completed.';
