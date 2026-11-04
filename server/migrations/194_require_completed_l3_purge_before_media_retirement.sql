-- Clearing the submission's storage pointer is the database-visible signal
-- that encrypted media has been physically purged. It must be paired with a
-- completed durable purge job in the same transaction; a job cannot be marked
-- completed while the submission still references the encrypted object.
CREATE OR REPLACE FUNCTION guard_identity_l3_media_purge_job_completion()
RETURNS trigger LANGUAGE plpgsql AS $l3_purge_job_completion$
DECLARE
  live_storage_key TEXT;
BEGIN
  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
    IF OLD.status <> 'processing'
       OR NEW.completed_at IS NULL
       OR NEW.lease_token IS NOT NULL
       OR NEW.lease_expires_at IS NOT NULL THEN
      RAISE EXCEPTION 'L3 media purge job can complete only from an active processing lease'
        USING ERRCODE = '55000';
    END IF;

    SELECT storage_object_key
    INTO live_storage_key
    FROM identity_l3_submissions
    WHERE id = NEW.submission_id
      AND user_id = NEW.user_id;

    IF NOT FOUND OR live_storage_key IS NOT NULL THEN
      RAISE EXCEPTION 'L3 media purge job cannot complete while its submission retains an encrypted object key'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN NEW;
END;
$l3_purge_job_completion$;

CREATE TRIGGER identity_l3_media_purge_job_completion_guard
  BEFORE UPDATE OF status, completed_at, lease_token, lease_expires_at
  ON identity_l3_media_purge_jobs
  FOR EACH ROW
  EXECUTE FUNCTION guard_identity_l3_media_purge_job_completion();

CREATE OR REPLACE FUNCTION require_completed_identity_l3_media_purge_job()
RETURNS trigger LANGUAGE plpgsql AS $l3_submission_purge_completion$
BEGIN
  IF NEW.media_purged_at IS NOT NULL
     AND NEW.media_purged_at IS DISTINCT FROM OLD.media_purged_at THEN
    IF NEW.storage_object_key IS NOT NULL OR NOT EXISTS (
      SELECT 1
      FROM identity_l3_media_purge_jobs AS job
      WHERE job.submission_id = NEW.id
        AND job.user_id = NEW.user_id
        AND job.status = 'completed'
        AND job.completed_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'L3 media purge timestamp requires a completed matching purge job and a cleared object key'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NULL;
END;
$l3_submission_purge_completion$;

CREATE CONSTRAINT TRIGGER identity_l3_submission_requires_completed_purge_job
  AFTER UPDATE OF media_purged_at ON identity_l3_submissions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION require_completed_identity_l3_media_purge_job();

COMMENT ON FUNCTION guard_identity_l3_media_purge_job_completion() IS
  'Requires a purge job to transition from processing to completed only after its submission no longer references encrypted media.';
COMMENT ON FUNCTION require_completed_identity_l3_media_purge_job() IS
  'Requires every new media_purged_at value to be paired with a completed purge job in the same committed transaction.';
