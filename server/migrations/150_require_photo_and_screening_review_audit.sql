-- Review states are evidence-bearing decisions. Do not allow direct SQL to
-- create an already-reviewed asset/screening or change its review state without
-- the corresponding immutable audit row in the same transaction.
CREATE OR REPLACE FUNCTION require_photo_asset_initial_review_state()
RETURNS trigger LANGUAGE plpgsql AS $photo_initial_review$
BEGIN
  IF NEW.review_status NOT IN ('pending', 'approved') THEN
    RAISE EXCEPTION 'photo assets must be created pending review or with an automated approval decision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$photo_initial_review$;

CREATE TRIGGER photo_assets_initial_review_state_guard
  BEFORE INSERT ON photo_assets
  FOR EACH ROW
  EXECUTE FUNCTION require_photo_asset_initial_review_state();

CREATE OR REPLACE FUNCTION require_photo_asset_review_audit()
RETURNS trigger LANGUAGE plpgsql AS $photo_review_audit$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.review_status = 'approved' THEN
    IF NOT EXISTS (
      SELECT 1 FROM moderation_audit_log AS audit
      WHERE audit.action = 'photo_ai_approved'
        AND audit.target_type = 'photo'
        AND audit.target_id = NEW.id::text
    ) THEN
      RAISE EXCEPTION 'automatically approved photo requires matching moderation evidence'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_OP = 'UPDATE' AND NEW.review_status IS DISTINCT FROM OLD.review_status THEN
    IF NEW.review_status NOT IN ('approved', 'rejected') OR NOT EXISTS (
      SELECT 1
      FROM moderation_audit_log AS audit
      JOIN users AS moderator ON moderator.id = audit.moderator_ref
      WHERE audit.action = 'photo_' || NEW.review_status
        AND audit.target_type = 'photo_asset'
        AND audit.target_id = NEW.id::text
        AND audit.details->>'userId' = NEW.user_id::text
        AND moderator.status = 'active'
        AND moderator.role IN ('admin', 'moderator')
    ) THEN
      RAISE EXCEPTION 'photo review transition requires matching active moderator audit evidence'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$photo_review_audit$;

CREATE CONSTRAINT TRIGGER photo_assets_review_audit_guard
  AFTER INSERT OR UPDATE ON photo_assets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION require_photo_asset_review_audit();

CREATE OR REPLACE FUNCTION require_safety_screening_initial_review_state()
RETURNS trigger LANGUAGE plpgsql AS $screening_initial_review$
BEGIN
  IF NEW.review_status NOT IN ('pending', 'not_required') THEN
    RAISE EXCEPTION 'safety screenings must be created pending review or not requiring review'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$screening_initial_review$;

CREATE TRIGGER user_safety_screenings_initial_review_state_guard
  BEFORE INSERT ON user_safety_screenings
  FOR EACH ROW
  EXECUTE FUNCTION require_safety_screening_initial_review_state();

CREATE OR REPLACE FUNCTION require_safety_screening_review_audit()
RETURNS trigger LANGUAGE plpgsql AS $screening_review_audit$
BEGIN
  IF NEW.review_status IS NOT DISTINCT FROM OLD.review_status
     AND (NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
          OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by) THEN
    -- Preserve the opaque reviewer snapshot while allowing only the nested
    -- ON DELETE SET NULL FK action to clear the live reviewer FK.
    IF pg_trigger_depth() > 1
       AND OLD.reviewed_by IS NOT NULL
       AND NEW.reviewed_by IS NULL
       AND NEW.reviewed_at IS NOT DISTINCT FROM OLD.reviewed_at
       AND (to_jsonb(NEW) - 'reviewed_by') = (to_jsonb(OLD) - 'reviewed_by') THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'safety screening reviewer metadata cannot change without a review-state transition'
      USING ERRCODE = '23514';
  END IF;

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

CREATE CONSTRAINT TRIGGER user_safety_screenings_review_audit_guard
  AFTER UPDATE ON user_safety_screenings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION require_safety_screening_review_audit();

COMMENT ON FUNCTION require_photo_asset_initial_review_state() IS
  'Prevents photo assets from being inserted already rejected or manually approved.';
COMMENT ON FUNCTION require_photo_asset_review_audit() IS
  'Requires an AI approval audit row for automatically approved photo inserts and a matching active moderator audit row for every manual review-state transition.';
COMMENT ON FUNCTION require_safety_screening_initial_review_state() IS
  'Prevents safety screening rows from being inserted already reviewed or actioned.';
COMMENT ON FUNCTION require_safety_screening_review_audit() IS
  'Requires every safety screening review-state transition to have a matching immutable audit row by the same active moderator in the same transaction.';
