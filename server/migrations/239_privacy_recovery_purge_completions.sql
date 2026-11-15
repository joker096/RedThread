-- Durable proof that a privacy-recovery purge obligation was physically processed.
-- The operational queue row is deleted on success, so it cannot double as a
-- completion record. This table preserves only the event identity and path hash.
CREATE TABLE IF NOT EXISTS privacy_recovery_replay_purge_completions (
  ledger_sequence BIGINT NOT NULL,
  queue_name TEXT NOT NULL CHECK (queue_name IN ('private_photo', 'private_voice_intro')),
  storage_path_sha256 TEXT NOT NULL CHECK (storage_path_sha256 ~ '^[a-f0-9]{64}$'),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (ledger_sequence, queue_name, storage_path_sha256),
  FOREIGN KEY (ledger_sequence, queue_name, storage_path_sha256)
    REFERENCES privacy_recovery_replay_purge_obligations
      (ledger_sequence, queue_name, storage_path_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION prevent_privacy_recovery_purge_completion_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'privacy recovery purge completions are immutable' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS privacy_recovery_purge_completions_no_update
  ON privacy_recovery_replay_purge_completions;
CREATE TRIGGER privacy_recovery_purge_completions_no_update
  BEFORE UPDATE OR DELETE ON privacy_recovery_replay_purge_completions
  FOR EACH ROW EXECUTE FUNCTION prevent_privacy_recovery_purge_completion_mutation();

COMMENT ON TABLE privacy_recovery_replay_purge_completions IS
  'Append-only proof that a private-media purge worker successfully unlinked (or confirmed absent) a file associated with an immutable privacy-recovery obligation.';
