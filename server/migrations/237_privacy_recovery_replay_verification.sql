-- Persist minimal replay effects and hashed purge obligations so an isolated
-- restore can verify domain state without exposing storage paths in reports.
CREATE UNIQUE INDEX IF NOT EXISTS privacy_recovery_receipts_sequence_event_pair_idx
  ON privacy_recovery_replay_receipts (ledger_sequence, event_id);

CREATE TABLE IF NOT EXISTS privacy_recovery_replay_effects (
  ledger_sequence BIGINT PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'private_photo_erasure_requested',
    'voice_intro_erasure_requested',
    'voice_intro_consent_withdrawn'
  )),
  subject_user_id UUID NOT NULL,
  resource_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (ledger_sequence, event_id)
    REFERENCES privacy_recovery_replay_receipts (ledger_sequence, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (
    (event_type IN ('private_photo_erasure_requested', 'voice_intro_erasure_requested') AND resource_id IS NOT NULL)
    OR (event_type = 'voice_intro_consent_withdrawn' AND resource_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS privacy_recovery_replay_purge_obligations (
  ledger_sequence BIGINT NOT NULL,
  event_id UUID NOT NULL,
  queue_name TEXT NOT NULL CHECK (queue_name IN ('private_photo', 'private_voice_intro')),
  storage_path_sha256 TEXT NOT NULL CHECK (storage_path_sha256 ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (ledger_sequence, queue_name, storage_path_sha256),
  FOREIGN KEY (ledger_sequence, event_id)
    REFERENCES privacy_recovery_replay_receipts (ledger_sequence, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION prevent_privacy_recovery_effect_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'privacy recovery effects are immutable' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS privacy_recovery_effects_no_update ON privacy_recovery_replay_effects;
CREATE TRIGGER privacy_recovery_effects_no_update
  BEFORE UPDATE OR DELETE ON privacy_recovery_replay_effects
  FOR EACH ROW EXECUTE FUNCTION prevent_privacy_recovery_effect_mutation();

CREATE OR REPLACE FUNCTION prevent_privacy_recovery_obligation_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'privacy recovery purge obligations are immutable' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS privacy_recovery_obligations_no_update ON privacy_recovery_replay_purge_obligations;
CREATE TRIGGER privacy_recovery_obligations_no_update
  BEFORE UPDATE OR DELETE ON privacy_recovery_replay_purge_obligations
  FOR EACH ROW EXECUTE FUNCTION prevent_privacy_recovery_obligation_mutation();

COMMENT ON TABLE privacy_recovery_replay_effects IS
  'Immutable internal mapping of successfully replayed event to restored subject/resource rows; only used by isolated post-replay verification.';
COMMENT ON TABLE privacy_recovery_replay_purge_obligations IS
  'Immutable SHA-256 references to queued private-file deletion obligations; raw storage paths remain only in their operational purge queues.';
