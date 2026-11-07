-- A new L3 submission is an empty draft. It must not arrive with a
-- fabricated purge timestamp, storage key, uploaded media metadata, processing
-- lease, or moderator decision; those facts belong to guarded later transitions.
CREATE OR REPLACE FUNCTION guard_identity_l3_submission_initial_state()
RETURNS trigger LANGUAGE plpgsql AS $l3_submission_initial_state$
BEGIN
  IF NEW.status <> 'draft'
     OR NEW.storage_object_key IS NOT NULL
     OR NEW.media_sha256 IS NOT NULL
     OR NEW.media_mime_type IS NOT NULL
     OR NEW.media_size_bytes IS NOT NULL
     OR NEW.media_duration_seconds IS NOT NULL
     OR NEW.uploaded_at IS NOT NULL
     OR NEW.processing_completed_at IS NOT NULL
     OR NEW.media_purged_at IS NOT NULL
     OR NEW.reviewed_by IS NOT NULL
     OR NEW.reviewed_at IS NOT NULL
     OR NEW.decision_reason_code IS NOT NULL
     OR NEW.approved_at IS NOT NULL
     OR NEW.expires_at IS NOT NULL
     OR NEW.processing_attempts <> 0
     OR NEW.processing_lease_token IS NOT NULL
     OR NEW.processing_lease_expires_at IS NOT NULL
     OR NEW.processing_last_error_code IS NOT NULL THEN
    RAISE EXCEPTION 'identity L3 submissions must start as empty drafts without media, purge or decision evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$l3_submission_initial_state$;

CREATE TRIGGER identity_l3_submission_initial_state_guard
  BEFORE INSERT ON identity_l3_submissions
  FOR EACH ROW
  EXECUTE FUNCTION guard_identity_l3_submission_initial_state();

COMMENT ON FUNCTION guard_identity_l3_submission_initial_state() IS
  'Requires every new identity L3 submission to start as an empty draft; uploaded media, processing leases, moderator decisions and purge evidence must arise through later guarded transitions.';
