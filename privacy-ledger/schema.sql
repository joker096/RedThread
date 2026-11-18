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
    'gift_order_consent_withdrawn',
    'gift_address_draft_consent_withdrawn'
  )),
  subject_ref TEXT NOT NULL CHECK (length(subject_ref) = 64),
  resource_ref TEXT CHECK (resource_ref IS NULL OR length(resource_ref) = 64),
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  CHECK (event_type <> 'gift_address_draft_consent_withdrawn' OR resource_ref IS NOT NULL)
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

CREATE TABLE IF NOT EXISTS privacy_snapshot_barriers (
  barrier_id TEXT PRIMARY KEY CHECK (length(barrier_id) = 36),
  snapshot_id TEXT NOT NULL UNIQUE CHECK (length(snapshot_id) BETWEEN 1 AND 64),
  status TEXT NOT NULL CHECK (status IN ('active', 'released')),
  ledger_sequence INTEGER NOT NULL CHECK (ledger_sequence >= 0),
  created_at TEXT NOT NULL,
  released_at TEXT,
  CHECK ((status = 'active' AND released_at IS NULL) OR
         (status = 'released' AND released_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS privacy_snapshot_barriers_one_active_idx
  ON privacy_snapshot_barriers(status)
  WHERE status = 'active';

CREATE TRIGGER IF NOT EXISTS privacy_snapshot_barriers_transition_guard
BEFORE UPDATE ON privacy_snapshot_barriers
WHEN OLD.status <> 'active'
  OR NEW.barrier_id <> OLD.barrier_id
  OR NEW.snapshot_id <> OLD.snapshot_id
  OR NEW.ledger_sequence <> OLD.ledger_sequence
  OR NEW.created_at <> OLD.created_at
  OR NEW.status <> 'released'
  OR NEW.released_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'privacy snapshot barrier transition is invalid');
END;

CREATE TRIGGER IF NOT EXISTS privacy_snapshot_barriers_no_delete
BEFORE DELETE ON privacy_snapshot_barriers
BEGIN
  SELECT RAISE(ABORT, 'privacy snapshot barriers are append-only');
END;
