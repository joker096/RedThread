-- Register the temporary gift-address draft consent withdrawal event in the
-- PostgreSQL ACK saga and immutable restore staging table. The event identifies
-- the durable gift order and must always carry its pseudonymized resource_ref.
ALTER TABLE privacy_recovery_events
  DROP CONSTRAINT IF EXISTS privacy_recovery_events_event_type_check;
ALTER TABLE privacy_recovery_events
  ADD CONSTRAINT privacy_recovery_events_event_type_check
  CHECK (event_type IN (
    'account_erasure_requested',
    'voice_intro_consent_withdrawn',
    'voice_intro_erasure_requested',
    'private_photo_erasure_requested',
    'identity_l3_consent_withdrawn',
    'ad_consent_revoked',
    'gift_order_consent_withdrawn',
    'gift_address_draft_consent_withdrawn'
  ));

ALTER TABLE privacy_recovery_events
  DROP CONSTRAINT IF EXISTS privacy_recovery_events_draft_resource_check;
ALTER TABLE privacy_recovery_events
  ADD CONSTRAINT privacy_recovery_events_draft_resource_check
  CHECK (
    event_type <> 'gift_address_draft_consent_withdrawn'
    OR resource_ref IS NOT NULL
  );

-- The original ACK-saga migration used an unnamed CHECK constraint.
-- Require exactly one matching event allowlist before replacing it; otherwise
-- fail closed rather than silently dropping unrelated or duplicate checks.
DO $migration$
DECLARE
  matching_constraint_count INTEGER;
  matching_constraint_name TEXT;
BEGIN
  SELECT count(*), min(conname)
    INTO matching_constraint_count, matching_constraint_name
    FROM pg_constraint
   WHERE conrelid = 'privacy_recovery_operations'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%gift_order_consent_withdrawn%';

  IF matching_constraint_count <> 1 THEN
    RAISE EXCEPTION
      'expected exactly one privacy_recovery_operations event-type CHECK, found %',
      matching_constraint_count;
  END IF;

  EXECUTE format(
    'ALTER TABLE privacy_recovery_operations DROP CONSTRAINT %I',
    matching_constraint_name
  );
END;
$migration$;

ALTER TABLE privacy_recovery_operations
  ADD CONSTRAINT privacy_recovery_operations_event_type_check
  CHECK (event_payload->>'event_type' IN (
    'account_erasure_requested',
    'voice_intro_consent_withdrawn',
    'voice_intro_erasure_requested',
    'private_photo_erasure_requested',
    'identity_l3_consent_withdrawn',
    'ad_consent_revoked',
    'gift_order_consent_withdrawn',
    'gift_address_draft_consent_withdrawn'
  ));

ALTER TABLE privacy_recovery_operations
  ADD CONSTRAINT privacy_recovery_operations_draft_resource_check
  CHECK (
    event_payload->>'event_type' <> 'gift_address_draft_consent_withdrawn'
    OR (
      event_payload ? 'resource_ref'
      AND jsonb_typeof(event_payload->'resource_ref') = 'string'
      AND event_payload->>'resource_ref' ~ '^[a-f0-9]{64}
    )
  );

    )
  );
