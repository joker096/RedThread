-- User reports may be created only as open evidence. Every later status
-- transition must be accompanied by an immutable audit entry from an active
-- admin/moderator in the same transaction.
CREATE OR REPLACE FUNCTION require_user_report_initial_open_status()
RETURNS trigger LANGUAGE plpgsql AS $user_report_initial_status$
BEGIN
  IF NEW.status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'user reports must be created in the open state'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$user_report_initial_status$;

CREATE TRIGGER user_reports_initial_open_status_guard
  BEFORE INSERT ON user_reports
  FOR EACH ROW
  EXECUTE FUNCTION require_user_report_initial_open_status();

CREATE OR REPLACE FUNCTION require_user_report_status_audit()
RETURNS trigger LANGUAGE plpgsql AS $user_report_status_audit$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT EXISTS (
       SELECT 1
       FROM moderation_audit_log AS audit
       JOIN users AS moderator ON moderator.id = audit.moderator_ref
       WHERE audit.target_type = 'user_report'
         AND audit.target_id = NEW.id::text
         AND audit.details->>'newStatus' = NEW.status
         AND audit.details->>'targetUserId' = NEW.reported_user_id::text
         AND audit.details->>'category' = NEW.category
         AND (
           (audit.action = 'dismiss' AND NEW.status = 'dismissed')
           OR (audit.action IN ('resolve', 'suspend_user') AND NEW.status = 'resolved')
         )
         AND moderator.status = 'active'
         AND moderator.role IN ('admin', 'moderator')
     ) THEN
    RAISE EXCEPTION 'user report status transition requires matching active moderator audit evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$user_report_status_audit$;

CREATE CONSTRAINT TRIGGER user_reports_status_audit_guard
  AFTER UPDATE ON user_reports
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION require_user_report_status_audit();

COMMENT ON FUNCTION require_user_report_initial_open_status() IS
  'Prevents reports from being inserted as already resolved or dismissed without a moderation workflow.';
COMMENT ON FUNCTION require_user_report_status_audit() IS
  'Requires every user report status transition to have a matching immutable moderation audit row for the same report and resulting status, written by an active admin/moderator in the same transaction.';
