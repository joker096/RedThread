-- A manual reconciliation case must never be closed without its matching
-- immutable moderator audit record. A deferred constraint trigger allows the
-- API/runbook to update the case and insert the audit row in either order,
-- while requiring both to exist before the transaction can commit.
CREATE OR REPLACE FUNCTION require_manual_paddle_adjustment_resolution_audit()
RETURNS trigger LANGUAGE plpgsql AS $manual_adjustment_audit$
BEGIN
  IF NEW.status = 'resolved' AND NEW.resolution_source = 'manual_operator'
     AND NOT EXISTS (
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
     ) THEN
    RAISE EXCEPTION 'manual Paddle adjustment resolution requires matching moderation audit evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$manual_adjustment_audit$;

CREATE CONSTRAINT TRIGGER paddle_adjustment_reconciliation_manual_audit_guard
  AFTER INSERT OR UPDATE ON paddle_adjustment_reconciliation_cases
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION require_manual_paddle_adjustment_resolution_audit();

COMMENT ON FUNCTION require_manual_paddle_adjustment_resolution_audit() IS
  'Requires every manual Paddle adjustment reconciliation resolution to have a matching append-only moderation audit row in the same transaction; automatic provider-link resolutions remain distinct.';
