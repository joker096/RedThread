-- Register gift-address draft withdrawal in the immutable replay evidence schema.
-- Migration 247 added the event to staging/ACK/outbox, but receipts and effects
-- retain their earlier allowlists. Keep the resource identity mandatory: this
-- event identifies one order and recipient, but creates no media purge queue.
ALTER TABLE privacy_recovery_replay_receipts
  DROP CONSTRAINT IF EXISTS privacy_recovery_replay_receipts_event_type_check;
ALTER TABLE privacy_recovery_replay_receipts
  ADD CONSTRAINT privacy_recovery_replay_receipts_event_type_check
  CHECK (event_type IN (
    'private_photo_erasure_requested',
    'voice_intro_erasure_requested',
    'voice_intro_consent_withdrawn',
    'identity_l3_consent_withdrawn',
    'gift_address_draft_consent_withdrawn'
  ));

-- Earlier migrations used both generated and explicit names for this
-- predicate. Drop every legacy variant so no narrower duplicate CHECK remains.
ALTER TABLE privacy_recovery_replay_receipts
  DROP CONSTRAINT IF EXISTS privacy_recovery_replay_receipts_outcome_code_check;
ALTER TABLE privacy_recovery_replay_receipts
  DROP CONSTRAINT IF EXISTS privacy_recovery_replay_receipts_event_outcome_check;
ALTER TABLE privacy_recovery_replay_receipts
  DROP CONSTRAINT IF EXISTS privacy_recovery_replay_receipts_check;
ALTER TABLE privacy_recovery_replay_receipts
  ADD CONSTRAINT privacy_recovery_replay_receipts_event_outcome_check
  CHECK (
    (event_type = 'private_photo_erasure_requested' AND outcome_code = 'photo_erasure_queued') OR
    (event_type = 'voice_intro_erasure_requested' AND outcome_code = 'voice_intro_erasure_queued') OR
    (event_type = 'voice_intro_consent_withdrawn' AND outcome_code = 'voice_intro_consent_withdrawn') OR
    (event_type = 'identity_l3_consent_withdrawn' AND outcome_code = 'identity_l3_consent_withdrawn') OR
    (event_type = 'gift_address_draft_consent_withdrawn' AND outcome_code = 'gift_address_draft_consent_withdrawn')
  );

ALTER TABLE privacy_recovery_replay_effects
  DROP CONSTRAINT IF EXISTS privacy_recovery_replay_effects_event_type_check;
ALTER TABLE privacy_recovery_replay_effects
  ADD CONSTRAINT privacy_recovery_replay_effects_event_type_check
  CHECK (event_type IN (
    'private_photo_erasure_requested',
    'voice_intro_erasure_requested',
    'voice_intro_consent_withdrawn',
    'identity_l3_consent_withdrawn',
    'gift_address_draft_consent_withdrawn'
  ));

ALTER TABLE privacy_recovery_replay_effects
  DROP CONSTRAINT IF EXISTS privacy_recovery_replay_effects_resource_check;
ALTER TABLE privacy_recovery_replay_effects
  ADD CONSTRAINT privacy_recovery_replay_effects_resource_check
  CHECK (
    (event_type IN ('private_photo_erasure_requested', 'voice_intro_erasure_requested',
                    'gift_address_draft_consent_withdrawn') AND resource_id IS NOT NULL)
    OR
    (event_type IN ('voice_intro_consent_withdrawn', 'identity_l3_consent_withdrawn')
      AND resource_id IS NULL)
  );

COMMENT ON TABLE privacy_recovery_replay_receipts IS
  'Append-only receipts for successfully applied photo, voice, L3-consent and temporary gift-address-draft withdrawal events. Receipts share a transaction with domain changes.';
COMMENT ON TABLE privacy_recovery_replay_effects IS
  'Immutable internal mapping of successfully replayed privacy events to restored subject/resource rows; used only by isolated post-replay verification.';
