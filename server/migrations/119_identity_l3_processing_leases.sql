-- Durable, lease-based processing state for the isolated L3 media worker.
-- Media duration is derived from ffprobe, never trusted from the upload request.
ALTER TABLE identity_l3_submissions
  ADD COLUMN processing_attempts SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN processing_lease_token UUID,
  ADD COLUMN processing_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN processing_next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  ADD COLUMN processing_last_error_code TEXT;

ALTER TABLE identity_l3_submissions
  ADD CONSTRAINT identity_l3_processing_attempts_check
    CHECK (processing_attempts BETWEEN 0 AND 5),
  ADD CONSTRAINT identity_l3_processing_lease_pair_check
    CHECK (
      (processing_lease_token IS NULL AND processing_lease_expires_at IS NULL)
      OR (
        status = 'processing'
        AND processing_lease_token IS NOT NULL
        AND processing_lease_expires_at IS NOT NULL
      )
    ),
  ADD CONSTRAINT identity_l3_processing_error_code_check
    CHECK (
      processing_last_error_code IS NULL
      OR (
        length(processing_last_error_code) BETWEEN 1 AND 64
        AND processing_last_error_code !~ '[^a-z0-9_]'
      )
    );

-- The original workflow schema required media_duration_seconds on uploaded
-- rows. That value cannot be trusted before ffprobe runs in the isolated worker.
-- Replace only that metadata CHECK, retaining all other workflow constraints.
DO $l3_duration_check$
DECLARE
  existing_check RECORD;
BEGIN
  FOR existing_check IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'identity_l3_submissions'::regclass
      AND contype = 'c'
      AND position('media_duration_seconds IS NOT NULL' IN pg_get_constraintdef(oid)) > 0
  LOOP
    EXECUTE format(
      'ALTER TABLE identity_l3_submissions DROP CONSTRAINT %I',
      existing_check.conname
    );
  END LOOP;
END;
$l3_duration_check$;

ALTER TABLE identity_l3_submissions
  ADD CONSTRAINT identity_l3_processing_metadata_check
  CHECK (
    status NOT IN ('uploaded', 'processing', 'failed', 'pending_review', 'approved', 'rejected')
    OR (
      media_sha256 IS NOT NULL
      AND media_mime_type IS NOT NULL
      AND media_size_bytes IS NOT NULL
      AND uploaded_at IS NOT NULL
      AND (
        (storage_object_key IS NOT NULL AND length(storage_object_key) BETWEEN 1 AND 512)
        OR (media_purged_at IS NOT NULL AND storage_object_key IS NULL)
      )
    )
  ),
  ADD CONSTRAINT identity_l3_review_requires_validated_duration_check
  CHECK (
    status NOT IN ('pending_review', 'approved', 'rejected')
    OR media_duration_seconds BETWEEN 30 AND 60
  );

CREATE INDEX identity_l3_processing_queue_idx
  ON identity_l3_submissions(processing_next_attempt_at, uploaded_at, id)
  WHERE status IN ('uploaded', 'processing');

COMMENT ON COLUMN identity_l3_submissions.processing_attempts IS
  'Number of worker leases issued; bounded to five attempts before a terminal failure.';
COMMENT ON COLUMN identity_l3_submissions.processing_lease_token IS
  'Fencing token for the active worker lease. A stale worker cannot complete a newer lease.';
COMMENT ON COLUMN identity_l3_submissions.processing_last_error_code IS
  'Bounded machine-readable processing error code; never store raw exception messages or media data.';
