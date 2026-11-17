-- Add the two remaining privacy-domain events. Ad revocation replays fail-closed
-- (all advertising purposes off) because the current ledger event carries no
-- category payload. Gift consent withdrawal is order-scoped.
ALTER TABLE privacy_recovery_replay_receipts
  DROP CONSTRAINT IF EXISTS privacy_recovery_replay_receipts_event_type_check;
ALTER TABLE privacy_recovery_replay_receipts
  ADD CONSTRAINT privacy_recovery_replay_receipts_event_type_check
  CHECK (event_type IN (
    'private_photo_erasure_requested',
    'voice_intro_erasure_requested',
    'voice_intro_consent_withdrawn',
    'identity_l3_consent_withdrawn',
    'account_erasure_requested',
    'ad_consent_revoked',
    'gift_order_consent_withdrawn'
  ));

ALTER TABLE privacy_recovery_replay_receipts
  DROP CONSTRAINT IF EXISTS privacy_recovery_replay_receipts_outcome_code_check;
ALTER TABLE privacy_recovery_replay_receipts
  DROP CONSTRAINT IF EXISTS privacy_recovery_replay_receipts_event_outcome_check;
ALTER TABLE privacy_recovery_replay_receipts
  ADD CONSTRAINT privacy_recovery_replay_receipts_outcome_code_check
  CHECK (
    (event_type = 'private_photo_erasure_requested' AND outcome_code = 'photo_erasure_queued') OR
    (event_type = 'voice_intro_erasure_requested' AND outcome_code = 'voice_intro_erasure_queued') OR
    (event_type = 'voice_intro_consent_withdrawn' AND outcome_code = 'voice_intro_consent_withdrawn') OR
    (event_type = 'identity_l3_consent_withdrawn' AND outcome_code = 'identity_l3_consent_withdrawn') OR
    (event_type = 'account_erasure_requested' AND outcome_code = 'account_erasure_replayed') OR
    (event_type = 'ad_consent_revoked' AND outcome_code = 'ad_consent_revoked_fail_closed') OR
    (event_type = 'gift_order_consent_withdrawn' AND outcome_code = 'gift_order_consent_withdrawn')
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
    'account_erasure_requested',
    'ad_consent_revoked',
    'gift_order_consent_withdrawn'
  ));

ALTER TABLE privacy_recovery_replay_effects
  DROP CONSTRAINT IF EXISTS privacy_recovery_replay_effects_resource_check;
ALTER TABLE privacy_recovery_replay_effects
  ADD CONSTRAINT privacy_recovery_replay_effects_resource_check
  CHECK (
    (event_type IN (
      'private_photo_erasure_requested',
      'voice_intro_erasure_requested',
      'gift_order_consent_withdrawn'
    ) AND resource_id IS NOT NULL)
    OR (event_type IN (
      'voice_intro_consent_withdrawn',
      'identity_l3_consent_withdrawn',
      'account_erasure_requested',
      'ad_consent_revoked'
    ) AND resource_id IS NULL)
  );
