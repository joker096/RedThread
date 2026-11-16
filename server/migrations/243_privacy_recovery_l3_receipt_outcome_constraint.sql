-- Replace the original table-level receipt outcome constraint (whose
-- PostgreSQL-generated name is table_check) with the L3-aware predicate.
ALTER TABLE privacy_recovery_replay_receipts
  DROP CONSTRAINT IF EXISTS privacy_recovery_replay_receipts_check;
ALTER TABLE privacy_recovery_replay_receipts
  ADD CONSTRAINT privacy_recovery_replay_receipts_event_outcome_check
  CHECK (
    (event_type = 'private_photo_erasure_requested' AND outcome_code = 'photo_erasure_queued') OR
    (event_type = 'voice_intro_erasure_requested' AND outcome_code = 'voice_intro_erasure_queued') OR
    (event_type = 'voice_intro_consent_withdrawn' AND outcome_code = 'voice_intro_consent_withdrawn') OR
    (event_type = 'identity_l3_consent_withdrawn' AND outcome_code = 'identity_l3_consent_withdrawn')
  );
