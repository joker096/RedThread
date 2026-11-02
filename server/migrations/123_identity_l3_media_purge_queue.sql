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
