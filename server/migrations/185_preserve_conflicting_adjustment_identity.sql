-- Preserve the provider adjustment identity when a conflicting signed event
-- is rejected by the append-only adjustment ledger trigger. The event ID and
-- transaction ID alone are insufficient to distinguish multiple adjustments
-- on one transaction during moderator investigation.
ALTER TABLE paddle_adjustment_reconciliation_cases
  ADD COLUMN provider_adjustment_id TEXT
    CHECK (provider_adjustment_id IS NULL OR provider_adjustment_id ~ '^adj_[A-Za-z0-9]+$');

CREATE OR REPLACE FUNCTION guard_paddle_adjustment_reconciliation_case()
RETURNS trigger LANGUAGE plpgsql AS $paddle_adjustment_case$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Paddle adjustment reconciliation evidence cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.provider_transaction_id IS DISTINCT FROM OLD.provider_transaction_id
     OR NEW.provider_adjustment_id IS DISTINCT FROM OLD.provider_adjustment_id
     OR NEW.provider_user_ref IS DISTINCT FROM OLD.provider_user_ref
     OR NEW.provider_plan IS DISTINCT FROM OLD.provider_plan THEN
    RAISE EXCEPTION 'Paddle reconciliation source evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'resolved' THEN
    RAISE EXCEPTION 'resolved Paddle adjustment reconciliation cases are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'open' AND NEW.status = 'resolved') THEN
    RAISE EXCEPTION 'invalid Paddle adjustment reconciliation case transition'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'resolved' AND (
    NEW.resolution_note IS NULL OR length(btrim(NEW.resolution_note)) = 0
    OR length(NEW.resolution_note) > 1000 OR NEW.resolved_at IS NULL
    OR NEW.resolution_source IS NULL
    OR (NEW.resolution_source = 'manual_operator' AND NEW.resolved_by_ref IS NULL)
    OR (NEW.resolution_source = 'automatic_provider_transaction_link' AND NEW.resolved_by_ref IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'resolved Paddle adjustment cases require a bounded resolution note and timestamp'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$paddle_adjustment_case$;

CREATE OR REPLACE FUNCTION require_manual_paddle_adjustment_resolution_audit()
RETURNS trigger LANGUAGE plpgsql AS $manual_adjustment_audit$
BEGIN
  IF NEW.status = 'resolved' AND NEW.resolution_source = 'manual_operator'
     AND (
       NOT EXISTS (
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
    RAISE EXCEPTION 'manual Paddle reconciliation requires matching moderator audit evidence and source context'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$manual_adjustment_audit$;

COMMENT ON COLUMN paddle_adjustment_reconciliation_cases.provider_adjustment_id IS
  'Validated Paddle adjustment ID retained when a conflicting signed adjustment event is rejected from the normalized ledger; immutable and contains no provider payload or payment credentials.';
