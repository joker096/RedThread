-- Immutable idempotency receipts for domain replay in an isolated restored database.
-- Receipts are written in the same transaction as the corresponding domain mutations.
DO $privacy_replay_pair_unique$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'privacy_recovery_events'::regclass
      AND conname = 'privacy_recovery_events_sequence_event_id_key'
  ) THEN
    ALTER TABLE privacy_recovery_events
      ADD CONSTRAINT privacy_recovery_events_sequence_event_id_key
      UNIQUE (ledger_sequence, event_id);
  END IF;
END;
$privacy_replay_pair_unique$;

CREATE TABLE IF NOT EXISTS privacy_recovery_replay_receipts (
  ledger_sequence BIGINT NOT NULL,
  event_id UUID NOT NULL,
  event_digest TEXT NOT NULL CHECK (event_digest ~ '^[a-fA-F0-9]{64}$'),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'private_photo_erasure_requested',
    'voice_intro_erasure_requested',
    'voice_intro_consent_withdrawn'
  )),
  outcome_code TEXT NOT NULL CHECK (outcome_code IN (
    'photo_erasure_queued',
    'voice_intro_erasure_queued',
    'voice_intro_consent_withdrawn'
  )),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (ledger_sequence),
  UNIQUE (event_id),
  FOREIGN KEY (ledger_sequence, event_id)
    REFERENCES privacy_recovery_events (ledger_sequence, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS privacy_recovery_replay_receipts_type_time_idx
  ON privacy_recovery_replay_receipts(event_type, applied_at);

CREATE OR REPLACE FUNCTION prevent_privacy_recovery_replay_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql AS $privacy_replay_receipt_immutable$
BEGIN
  RAISE EXCEPTION 'privacy recovery replay receipts are immutable'
    USING ERRCODE = '55000';
END;
$privacy_replay_receipt_immutable$;

DROP TRIGGER IF EXISTS privacy_recovery_replay_receipts_no_update
  ON privacy_recovery_replay_receipts;
CREATE TRIGGER privacy_recovery_replay_receipts_no_update
  BEFORE UPDATE ON privacy_recovery_replay_receipts
  FOR EACH ROW EXECUTE FUNCTION prevent_privacy_recovery_replay_receipt_mutation();

DROP TRIGGER IF EXISTS privacy_recovery_replay_receipts_no_delete
  ON privacy_recovery_replay_receipts;
CREATE TRIGGER privacy_recovery_replay_receipts_no_delete
  BEFORE DELETE ON privacy_recovery_replay_receipts
  FOR EACH ROW EXECUTE FUNCTION prevent_privacy_recovery_replay_receipt_mutation();

COMMENT ON TABLE privacy_recovery_replay_receipts IS
  'Append-only receipts for successfully applied private photo/voice privacy events. Receipt insertion must share the transaction with domain changes; exact retries are no-ops and conflicting event identities abort.';
