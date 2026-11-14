CREATE TABLE IF NOT EXISTS privacy_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'account_erasure_requested',
    'voice_intro_consent_withdrawn',
    'voice_intro_erasure_requested',
    'private_photo_erasure_requested',
    'identity_l3_consent_withdrawn',
    'ad_consent_revoked',
    'gift_order_consent_withdrawn'
  )),
  subject_ref TEXT NOT NULL CHECK (length(subject_ref) = 64),
  resource_ref TEXT CHECK (resource_ref IS NULL OR length(resource_ref) = 64),
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64)
);

CREATE INDEX IF NOT EXISTS privacy_events_subject_sequence_idx
  ON privacy_events(subject_ref, sequence);

CREATE TRIGGER IF NOT EXISTS privacy_events_no_update
BEFORE UPDATE ON privacy_events
BEGIN
  SELECT RAISE(ABORT, 'privacy ledger events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS privacy_events_no_delete
BEFORE DELETE ON privacy_events
BEGIN
  SELECT RAISE(ABORT, 'privacy ledger events are append-only');
END;
