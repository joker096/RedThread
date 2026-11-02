-- PostgreSQL CHECK constraints accept NULL (unknown) results. Require an
-- explicitly present ffprobe duration before any submission enters review.
ALTER TABLE identity_l3_submissions
  DROP CONSTRAINT identity_l3_review_requires_validated_duration_check;

ALTER TABLE identity_l3_submissions
  ADD CONSTRAINT identity_l3_review_requires_validated_duration_check
  CHECK (
    status NOT IN ('pending_review', 'approved', 'rejected')
    OR (
      media_duration_seconds IS NOT NULL
      AND media_duration_seconds BETWEEN 30 AND 60
    )
  );
