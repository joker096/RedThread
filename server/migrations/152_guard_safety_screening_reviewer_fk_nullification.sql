-- Enforce reviewer metadata immutability in a BEFORE trigger, where the
-- nested FK action depth is observable. Deferred constraint triggers execute
-- after the FK trigger has returned and cannot safely use trigger depth.
CREATE OR REPLACE FUNCTION guard_safety_screening_reviewer_metadata()
RETURNS trigger LANGUAGE plpgsql AS $screening_reviewer_guard$
BEGIN
  IF NEW.review_status IS NOT DISTINCT FROM OLD.review_status
     AND (NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
          OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by) THEN
    IF pg_trigger_depth() > 1
       AND OLD.reviewed_by IS NOT NULL
       AND NEW.reviewed_by IS NULL
       AND NEW.reviewed_at IS NOT DISTINCT FROM OLD.reviewed_at
       AND (to_jsonb(NEW) - 'reviewed_by') = (to_jsonb(OLD) - 'reviewed_by') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'safety screening reviewer metadata cannot change without a review-state transition'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$screening_reviewer_guard$;

DROP TRIGGER IF EXISTS user_safety_screenings_reviewer_metadata_guard
  ON user_safety_screenings;
CREATE TRIGGER user_safety_screenings_reviewer_metadata_guard
  BEFORE UPDATE ON user_safety_screenings
  FOR EACH ROW
  EXECUTE FUNCTION guard_safety_screening_reviewer_metadata();

CREATE OR REPLACE FUNCTION require_safety_screening_review_audit()
RETURNS trigger LANGUAGE plpgsql AS $screening_review_audit$
BEGIN
  IF NEW.review_status IS DISTINCT FROM OLD.review_status
     AND NOT EXISTS (
       SELECT 1
       FROM moderation_audit_log AS audit
       JOIN users AS moderator ON moderator.id = audit.moderator_ref
       WHERE audit.action = 'screening_' || NEW.review_status
         AND audit.target_type = 'safety_screening'
         AND audit.target_id = NEW.id::text
         AND audit.details->>'userId' = NEW.user_id::text
         AND audit.details->>'newStatus' = NEW.review_status
         AND NEW.reviewed_by = audit.moderator_ref
         AND NEW.reviewed_at IS NOT NULL
         AND moderator.status = 'active'
         AND moderator.role IN ('admin', 'moderator')
     ) THEN
    RAISE EXCEPTION 'safety screening review transition requires matching active moderator audit evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$screening_review_audit$;

COMMENT ON FUNCTION guard_safety_screening_reviewer_metadata() IS
  'Rejects direct reviewer metadata edits while allowing only the nested ON DELETE SET NULL FK action to clear the live moderator reference.';
COMMENT ON FUNCTION require_safety_screening_review_audit() IS
  'Requires every safety screening review-state transition to have a matching immutable audit row by the same active moderator in the same transaction.';
