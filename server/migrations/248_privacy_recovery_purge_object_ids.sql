-- Preserve the server-generated media object UUID alongside the one-way path digest.
-- The UUID is needed to inspect a relocated restore tree without storing raw paths.
ALTER TABLE privacy_recovery_replay_purge_obligations
  ADD COLUMN IF NOT EXISTS storage_object_id UUID;

COMMENT ON COLUMN privacy_recovery_replay_purge_obligations.storage_object_id IS
  'Server-generated UUID basename of the purged media object. New replay obligations populate it so isolated restore verification can check relocated media roots without retaining absolute storage paths.';
