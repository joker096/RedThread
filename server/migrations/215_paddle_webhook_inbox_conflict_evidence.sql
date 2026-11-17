-- Preserve hash-only evidence when a verified Paddle event ID is reused
-- with different content. Raw conflicting payloads are never retained.
ALTER TABLE paddle_webhook_inbox
  ADD COLUMN IF NOT EXISTS payload_sha256 CHAR(64);

ALTER TABLE paddle_webhook_inbox
  ADD CONSTRAINT paddle_webhook_inbox_payload_sha256_check
  CHECK (payload_sha256 IS NULL OR payload_sha256 ~ '^[a-f0-9]{64}$');

CREATE TABLE paddle_webhook_inbox_conflicts (
  event_id TEXT NOT NULL
    REFERENCES paddle_webhook_inbox(event_id) ON DELETE RESTRICT,
  original_payload_sha256 CHAR(64),
  conflicting_payload_sha256 CHAR(64) NOT NULL
    CHECK (conflicting_payload_sha256 ~ '^[a-f0-9]{64}$'),
  conflicting_event_type TEXT NOT NULL
    CHECK (length(conflicting_event_type) BETWEEN 1 AND 128),
  conflicting_occurred_at TIMESTAMPTZ,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (event_id, conflicting_payload_sha256),
  CHECK (original_payload_sha256 IS NULL OR original_payload_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (original_payload_sha256 IS NULL OR original_payload_sha256 <> conflicting_payload_sha256)
);

CREATE OR REPLACE FUNCTION reject_paddle_webhook_inbox_conflict_mutation()
RETURNS trigger LANGUAGE plpgsql AS $paddle_webhook_conflict_immutable$
BEGIN
  RAISE EXCEPTION 'Paddle webhook inbox conflict evidence is append-only'
    USING ERRCODE = '55000';
END;
$paddle_webhook_conflict_immutable$;

CREATE TRIGGER paddle_webhook_inbox_conflicts_no_update_delete
  BEFORE UPDATE OR DELETE ON paddle_webhook_inbox_conflicts
  FOR EACH ROW EXECUTE FUNCTION reject_paddle_webhook_inbox_conflict_mutation();

CREATE OR REPLACE FUNCTION reject_paddle_webhook_inbox_conflict_truncate()
RETURNS trigger LANGUAGE plpgsql AS $paddle_webhook_conflict_no_truncate$
BEGIN
  RAISE EXCEPTION 'Paddle webhook inbox conflict evidence cannot be truncated'
    USING ERRCODE = '55000';
END;
$paddle_webhook_conflict_no_truncate$;

CREATE TRIGGER paddle_webhook_inbox_conflicts_no_truncate
  BEFORE TRUNCATE ON paddle_webhook_inbox_conflicts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_paddle_webhook_inbox_conflict_truncate();

COMMENT ON TABLE paddle_webhook_inbox_conflicts IS
  'Append-only hashes and event metadata for signature-verified Paddle webhook deliveries that reuse an event ID with different content; raw payloads and personal data are never stored.';
COMMENT ON COLUMN paddle_webhook_inbox.payload_sha256 IS
  'SHA-256 of canonical verified event JSON, retained after raw payload deletion so duplicate deliveries can be distinguished from conflicting event-ID reuse.';
