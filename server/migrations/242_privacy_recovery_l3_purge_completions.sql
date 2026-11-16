-- Permit the L3 purge worker to record the same immutable completion proof
-- used by photo/voice workers, keyed only by the encrypted object-key digest.
ALTER TABLE privacy_recovery_replay_purge_completions
  DROP CONSTRAINT IF EXISTS privacy_recovery_replay_purge_completions_queue_name_check;
ALTER TABLE privacy_recovery_replay_purge_completions
  ADD CONSTRAINT privacy_recovery_replay_purge_completions_queue_name_check
  CHECK (queue_name IN ('private_photo', 'private_voice_intro', 'identity_l3_media'));
