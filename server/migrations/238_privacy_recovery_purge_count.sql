-- Record the exact number of private-file purge tasks created by each replayed event.
-- This lets isolated restore verification detect partially populated deletion queues.
ALTER TABLE privacy_recovery_replay_effects
  ADD COLUMN purge_count INTEGER NOT NULL DEFAULT 0
  CHECK (purge_count >= 0);

-- Migration backfill is the only permitted exception to the append-only effect
-- policy. Drop only the UPDATE/DELETE guard for this controlled statement, then
-- restore it immediately. No application/runtime path may mutate these rows.
DROP TRIGGER IF EXISTS privacy_recovery_effects_no_update
  ON privacy_recovery_replay_effects;

UPDATE privacy_recovery_replay_effects AS effect
   SET purge_count = (
     SELECT count(*)::INTEGER
       FROM privacy_recovery_replay_purge_obligations AS obligation
      WHERE obligation.ledger_sequence = effect.ledger_sequence
        AND obligation.event_id = effect.event_id
   );

CREATE TRIGGER privacy_recovery_effects_no_update
  BEFORE UPDATE OR DELETE ON privacy_recovery_replay_effects
  FOR EACH ROW EXECUTE FUNCTION prevent_privacy_recovery_effect_mutation();

COMMENT ON COLUMN privacy_recovery_replay_effects.purge_count IS
  'Exact number of private-file purge obligations atomically created by this replay event.';
