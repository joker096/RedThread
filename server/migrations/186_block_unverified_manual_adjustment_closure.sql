-- A manual note is not a substitute for repairing a missing or ambiguous
-- account/entitlement link. Those cases must remain open until the provider
-- transaction is uniquely linked or a dedicated remediation flow exists.
-- Drain in-flight resolutions and prevent a stale trigger definition from
-- committing an unverified closure while this guard is being replaced.
LOCK TABLE paddle_adjustment_reconciliation_cases IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION require_manual_paddle_adjustment_resolution_audit()
RETURNS trigger LANGUAGE plpgsql AS $manual_adjustment_audit$
BEGIN
  IF NEW.status = 'resolved' AND NEW.resolution_source = 'manual_operator'
     AND (
       NEW.reason_code NOT IN (
         'invalid_adjustment_payload',
         'provider_identity_conflict',
         'provider_lifecycle_conflict'
       )
       OR NOT EXISTS (
         SELECT 1 FROM paddle_webhook_events AS webhook
         WHERE webhook.event_id = NEW.event_id
           AND webhook.event_type IN (
             'adjustment.created', 'adjustment.updated',
             'customer.created', 'customer.updated'
           )
       )
       OR NOT EXISTS (
         SELECT 1 FROM users AS moderator
         WHERE moderator.id = NEW.resolved_by_ref
           AND moderator.status = 'active'
           AND moderator.role IN ('admin', 'moderator')
       )
       OR NOT EXISTS (
         SELECT 1
         FROM moderation_audit_log AS audit
         WHERE audit.action = 'paddle_adjustment_reconciliation_resolved'
           AND audit.target_type = 'paddle_adjustment_case'
           AND audit.target_id = NEW.event_id
           AND audit.reason = NEW.resolution_note
           AND audit.moderator_ref = NEW.resolved_by_ref
           AND audit.details->>'eventId' = NEW.event_id
           AND audit.details->>'reasonCode' = NEW.reason_code
           AND audit.details->>'resolutionSource' = 'manual_operator'
           AND audit.details->>'adjustmentId' IS NOT DISTINCT FROM
             COALESCE(
               NEW.provider_adjustment_id,
               (SELECT source.adjustment_id FROM paddle_adjustment_events AS source
                WHERE source.event_id = NEW.event_id)
             )
           AND audit.details->>'transactionId' IS NOT DISTINCT FROM
             COALESCE(
               NEW.provider_transaction_id,
               (SELECT source.transaction_id FROM paddle_adjustment_events AS source
                WHERE source.event_id = NEW.event_id)
             )
           AND audit.details->>'providerUserRef' IS NOT DISTINCT FROM NEW.provider_user_ref::text
           AND audit.details->>'providerPlan' IS NOT DISTINCT FROM NEW.provider_plan
       )
     ) THEN
    RAISE EXCEPTION 'manual Paddle resolution requires an eligible non-entitlement case and matching moderator audit evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$manual_adjustment_audit$;

COMMENT ON FUNCTION require_manual_paddle_adjustment_resolution_audit() IS
  'Allows manual closure only for reviewed malformed payload or provider identity/lifecycle conflicts, with matching immutable audit evidence; unresolved/ambiguous owner links, inactive accounts and missing entitlements cannot be cleared by a note. Automatic verified transaction links remain separate.';
