-- Record the exact number of private-file purge tasks created by each replayed event.
-- This lets isolated restore verification detect partially populated deletion queues.
ALTER TABLE privacy_recovery_replay_effects
  ADD COLUMN purge_count INTEGER NOT NULL DEFAULT 0
  CHECK (purge_count >= 0);

COMMENT ON COLUMN privacy_recovery_replay_effects.purge_count IS
  'Exact number of private-file purge obligations atomically created by this replay event.';
