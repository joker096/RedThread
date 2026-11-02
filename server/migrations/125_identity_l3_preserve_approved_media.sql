-- An active approval retains its encrypted evidence until its six-month expiry.
-- Correct the queue predicate defensively for databases that applied an earlier
-- draft of migration 123 before the retention rule was finalized.
CREATE OR REPLACE FUNCTION enqueue_identity_l3_media_purge()
RETURNS trigger LANGUAGE plpgsql AS $l3_purge_enqueue$
BEGIN
  IF NEW.storage_object_key IS NOT NULL
     AND NEW.status IN ('rejected', 'withdrawn', 'revoked', 'expired', 'failed')
     AND (
       TG_OP = 'INSERT'
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.storage_object_key IS DISTINCT FROM OLD.storage_object_key
     ) THEN
    INSERT INTO identity_l3_media_purge_jobs (submission_id, user_id)
    VALUES (NEW.id, NEW.user_id)
    ON CONFLICT (submission_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$l3_purge_enqueue$;

-- Remove only untouched queued jobs for currently approved submissions. Never
-- interfere with a lease or a deletion that has already started.
DELETE FROM identity_l3_media_purge_jobs j
USING identity_l3_submissions s
WHERE s.id = j.submission_id
  AND s.user_id = j.user_id
  AND s.status = 'approved'
  AND s.storage_object_key IS NOT NULL
  AND j.status = 'queued'
  AND j.attempts = 0;

INSERT INTO identity_l3_media_purge_jobs (submission_id, user_id)
SELECT id, user_id
FROM identity_l3_submissions
WHERE status IN ('rejected', 'withdrawn', 'revoked', 'expired', 'failed')
  AND storage_object_key IS NOT NULL
ON CONFLICT (submission_id) DO NOTHING;
