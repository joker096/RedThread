-- A pending purge job is the durable obligation to delete an encrypted
-- identity video. Deleting its submission used to cascade-delete that job even
-- while storage_object_key still pointed at a live file, orphaning sensitive
-- media with no worker capable of finding it.
CREATE OR REPLACE FUNCTION prevent_identity_l3_submission_delete_with_live_media()
RETURNS trigger LANGUAGE plpgsql AS $l3_submission_delete_guard$
BEGIN
  IF OLD.storage_object_key IS NOT NULL THEN
    RAISE EXCEPTION 'identity L3 submission cannot be deleted while encrypted media remains'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$l3_submission_delete_guard$;

CREATE TRIGGER identity_l3_submissions_retain_live_media
  BEFORE DELETE ON identity_l3_submissions
  FOR EACH ROW
  EXECUTE FUNCTION prevent_identity_l3_submission_delete_with_live_media();

CREATE OR REPLACE FUNCTION prevent_identity_l3_media_purge_job_delete()
RETURNS trigger LANGUAGE plpgsql AS $l3_purge_job_delete_guard$
BEGIN
  -- A completed job may disappear only as a nested FK cascade after its
  -- already-purged submission is physically removed. Direct deletion of queued,
  -- processing or failed jobs would silently abandon a privacy obligation.
  IF pg_trigger_depth() > 1
     AND OLD.status = 'completed'
     AND OLD.completed_at IS NOT NULL THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'identity L3 media purge jobs cannot be deleted before completed submission cleanup'
    USING ERRCODE = '55000';
END;
$l3_purge_job_delete_guard$;

CREATE TRIGGER identity_l3_media_purge_jobs_no_delete
  BEFORE DELETE ON identity_l3_media_purge_jobs
  FOR EACH ROW
  EXECUTE FUNCTION prevent_identity_l3_media_purge_job_delete();

CREATE TRIGGER identity_l3_submissions_no_truncate
  BEFORE TRUNCATE ON identity_l3_submissions
  FOR EACH STATEMENT
  EXECUTE FUNCTION prevent_evidence_truncate();

CREATE TRIGGER identity_l3_media_purge_jobs_no_truncate
  BEFORE TRUNCATE ON identity_l3_media_purge_jobs
  FOR EACH STATEMENT
  EXECUTE FUNCTION prevent_evidence_truncate();

COMMENT ON FUNCTION prevent_identity_l3_submission_delete_with_live_media() IS
  'Prevents direct or cascading submission deletion while storage_object_key still references encrypted L3 media; the purge worker must clear the key and record media_purged_at first.';
COMMENT ON FUNCTION prevent_identity_l3_media_purge_job_delete() IS
  'Preserves queued, processing and failed privacy-purge obligations. Only a nested FK cascade of a completed job after its submission is safely purged may delete the queue row.';
