-- Extend isolated privacy-recovery replay to L3 consent withdrawal.
-- Domain mutations, queue obligations and immutable receipts are committed atomically.
ALTER TABLE privacy_recovery_replay_receipts
  DROP CONSTRAINT IF EXISTS privacy_recovery_replay_receipts_event_type_check;
ALTER TABLE privacy_recovery_replay_receipts
  ADD CONSTRAINT privacy_recovery_replay_receipts_event_type_check
  CHECK (event_type IN (
    'private_photo_erasure_requested',
    'voice_intro_erasure_requested',
    'voice_intro_consent_withdrawn',
    'identity_l3_consent_withdrawn'
  ));

ALTER TABLE privacy_recovery_replay_receipts
  DROP CONSTRAINT IF EXISTS privacy_recovery_replay_receipts_outcome_code_check;
ALTER TABLE privacy_recovery_replay_receipts
  ADD CONSTRAINT privacy_recovery_replay_receipts_outcome_code_check
  CHECK (
    (event_type = 'private_photo_erasure_requested' AND outcome_code = 'photo_erasure_queued') OR
    (event_type = 'voice_intro_erasure_requested' AND outcome_code = 'voice_intro_erasure_queued') OR
    (event_type = 'voice_intro_consent_withdrawn' AND outcome_code = 'voice_intro_consent_withdrawn') OR
    (event_type = 'identity_l3_consent_withdrawn' AND outcome_code = 'identity_l3_consent_withdrawn')
  );

ALTER TABLE privacy_recovery_replay_effects
  DROP CONSTRAINT IF EXISTS privacy_recovery_replay_effects_event_type_check;
ALTER TABLE privacy_recovery_replay_effects
  ADD CONSTRAINT privacy_recovery_replay_effects_event_type_check
  CHECK (event_type IN (
    'private_photo_erasure_requested',
    'voice_intro_erasure_requested',
    'voice_intro_consent_withdrawn',
    'identity_l3_consent_withdrawn'
  ));

ALTER TABLE privacy_recovery_replay_effects
  DROP CONSTRAINT IF EXISTS privacy_recovery_replay_effects_check;
ALTER TABLE privacy_recovery_replay_effects
  ADD CONSTRAINT privacy_recovery_replay_effects_resource_check
  CHECK (
    (event_type IN ('private_photo_erasure_requested', 'voice_intro_erasure_requested') AND resource_id IS NOT NULL)
    OR (event_type IN ('voice_intro_consent_withdrawn', 'identity_l3_consent_withdrawn') AND resource_id IS NULL)
  );

ALTER TABLE privacy_recovery_replay_purge_obligations
  DROP CONSTRAINT IF EXISTS privacy_recovery_replay_purge_obligations_queue_name_check;
ALTER TABLE privacy_recovery_replay_purge_obligations
  ADD CONSTRAINT privacy_recovery_replay_purge_obligations_queue_name_check
  CHECK (queue_name IN ('private_photo', 'private_voice_intro', 'identity_l3_media'));

COMMENT ON TABLE privacy_recovery_replay_receipts IS
  'Append-only receipts for successfully applied photo, voice and L3 consent privacy events. Receipts share a transaction with domain changes.';
