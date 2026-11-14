-- Record the exact number of private-file purge tasks created by each replayed event.
-- This lets isolated restore verification detect partially populated deletion queues.
ALTER TABLE privacy_recovery_replay_effects
  ADD COLUMN purge_count INTEGER NOT NULL DEFAULT 0
  CHECK (purge_count >= 0);

-- Preserve accurate counts for replay evidence written before this column existed.
UPDATE privacy_recovery_replay_effects AS effect
   SET purge_count = (
     SELECT count(*)::INTEGER
       FROM privacy_recovery_replay_purge_obligations AS obligation
      WHERE obligation.ledger_sequence = effect.ledger_sequence
        AND obligation.event_id = effect.event_id
   );

COMMENT ON COLUMN privacy_recovery_replay_effects.purge_count IS
  'Exact number of private-file purge obligations atomically created by this replay event.';
