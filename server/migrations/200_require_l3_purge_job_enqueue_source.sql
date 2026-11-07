-- A purge job is created only by the submission terminal-state trigger.
-- Direct INSERT must not manufacture a completed job and thereby satisfy the
-- deferred media_purged_at check without the physical purge worker.
CREATE OR REPLACE FUNCTION require_identity_l3_media_purge_job_enqueue_source()
RETURNS trigger LANGUAGE plpgsql AS $l3_purge_enqueue_source$
BEGIN
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'identity L3 purge jobs may only be enqueued by a guarded submission transition'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status <> 'queued'
     OR NEW.attempts <> 0
     OR NEW.lease_token IS NOT NULL
     OR NEW.lease_expires_at IS NOT NULL
     OR NEW.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'identity L3 purge jobs must start queued without a lease or completion state'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM identity_l3_submissions AS submission
    WHERE submission.id = NEW.submission_id
      AND submission.user_id = NEW.user_id
      AND submission.storage_object_key IS NOT NULL
      AND submission.status IN ('rejected', 'withdrawn', 'revoked', 'expired', 'failed')
  ) THEN
    RAISE EXCEPTION 'identity L3 purge job requires a retained object on a terminal submission'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$l3_purge_enqueue_source$;

CREATE TRIGGER identity_l3_media_purge_jobs_enqueue_source_guard
  BEFORE INSERT ON identity_l3_media_purge_jobs
  FOR EACH ROW
  EXECUTE FUNCTION require_identity_l3_media_purge_job_enqueue_source();

COMMENT ON FUNCTION require_identity_l3_media_purge_job_enqueue_source() IS
  'Allows purge-job creation only as a nested enqueue from a terminal submission transition, and requires a queued initial state with no forged lease/completion metadata and a live encrypted object reference.';
