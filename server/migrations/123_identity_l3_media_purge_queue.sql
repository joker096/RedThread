-- Durable retryable deletion of encrypted L3 media after applicant consent withdrawal.
-- The queue stores only the submission/user identifiers and operational state.
CREATE TABLE identity_l3_media_purge_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL,
  user_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  last_error_code TEXT CHECK (
    last_error_code IS NULL OR
    (length(last_error_code) BETWEEN 1 AND 64 AND last_error_code !~ '[^a-z0-9_]')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  completed_at TIMESTAMPTZ,
  UNIQUE (submission_id),
  FOREIGN KEY (submission_id, user_id)
    REFERENCES identity_l3_submissions(id, user_id) ON DELETE CASCADE,
  CHECK (
    (status = 'processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'processing' AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE INDEX identity_l3_media_purge_queue_idx
  ON identity_l3_media_purge_jobs(next_attempt_at, created_at, id)
  WHERE status IN ('queued', 'processing');

COMMENT ON TABLE identity_l3_media_purge_jobs IS
  'Durable retryable deletion queue for encrypted L3 video objects. Failed jobs retain the submission object key and block account deletion until reconciled.';

-- Every terminal transition with retained media must create a durable purge job,
-- including moderator rejection, processing failure, revocation and six-month expiry.
CREATE OR REPLACE FUNCTION enqueue_identity_l3_media_purge()
RETURNS trigger LANGUAGE plpgsql AS $l3_purge_enqueue$
BEGIN
  IF NEW.storage_object_key IS NOT NULL
     AND NEW.status IN ('approved', 'rejected', 'withdrawn', 'revoked', 'expired', 'failed')
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

CREATE TRIGGER identity_l3_submission_enqueue_media_purge
  AFTER INSERT OR UPDATE OF status, storage_object_key ON identity_l3_submissions
  FOR EACH ROW EXECUTE FUNCTION enqueue_identity_l3_media_purge();

-- Backfill terminal media created before the queue trigger was installed.
INSERT INTO identity_l3_media_purge_jobs (submission_id, user_id)
SELECT id, user_id
FROM identity_l3_submissions
WHERE status IN ('approved', 'rejected', 'withdrawn', 'revoked', 'expired', 'failed')
  AND storage_object_key IS NOT NULL
ON CONFLICT (submission_id) DO NOTHING;
