-- Extend the immutable privacy-event outbox contract for gift address-draft consent withdrawal.
-- Migration 240 predates this event type; replace its event-type CHECK without
-- rewriting historical migration files that may already have been applied.
DO $privacy_recovery_outbox_event_type$
DECLARE
  matching_constraint_count INTEGER;
  existing_constraint TEXT;
BEGIN
  SELECT count(*), min(constraint_row.conname)
    INTO matching_constraint_count, existing_constraint
    FROM pg_constraint AS constraint_row
   WHERE constraint_row.conrelid = 'privacy_recovery_ledger_outbox'::regclass
     AND constraint_row.contype = 'c'
     AND pg_get_constraintdef(constraint_row.oid) LIKE '%event_type%';

  IF matching_constraint_count <> 1 THEN
    RAISE EXCEPTION 'privacy_recovery_outbox_event_type_constraint_count_invalid: %',
      matching_constraint_count;
  END IF;

  EXECUTE format(
    'ALTER TABLE privacy_recovery_ledger_outbox DROP CONSTRAINT %I',
    existing_constraint
  );
END;
$privacy_recovery_outbox_event_type$;

ALTER TABLE privacy_recovery_ledger_outbox
  ADD CONSTRAINT privacy_recovery_outbox_event_type_allowed_check
  CHECK (COALESCE(event_payload->>'event_type', '') IN (
    'account_erasure_requested',
    'voice_intro_consent_withdrawn',
    'voice_intro_erasure_requested',
    'private_photo_erasure_requested',
    'identity_l3_consent_withdrawn',
    'ad_consent_revoked',
    'gift_order_consent_withdrawn',
    'gift_address_draft_consent_withdrawn'
  ));

ALTER TABLE privacy_recovery_ledger_outbox
  ADD CONSTRAINT privacy_recovery_outbox_address_draft_resource_check
  CHECK (
    event_payload->>'event_type' <> 'gift_address_draft_consent_withdrawn'
    OR COALESCE(event_payload->>'resource_ref', '') ~ '^[a-f0-9]{64}$'
  );
