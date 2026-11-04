-- A withdrawal timestamp is not sufficient by itself: all live L3 workflow
-- states must be revoked/withdrawn and every retained encrypted object must
-- have a durable purge obligation in the same transaction.
CREATE OR REPLACE FUNCTION require_identity_l3_withdrawal_purge_transition()
RETURNS trigger LANGUAGE plpgsql AS $l3_consent_withdrawal_guard$
BEGIN
  IF OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM identity_l3_submissions
      WHERE user_id = NEW.user_id
        AND status IN (
          'draft', 'upload_authorized', 'uploaded', 'processing',
          'pending_review', 'approved'
        )
    ) THEN
      RAISE EXCEPTION 'L3 consent withdrawal requires every active submission to be withdrawn or revoked'
        USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM identity_l3_submissions AS submission
      WHERE submission.user_id = NEW.user_id
        AND submission.storage_object_key IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM identity_l3_media_purge_jobs AS job
          WHERE job.submission_id = submission.id
            AND job.user_id = submission.user_id
        )
    ) THEN
      RAISE EXCEPTION 'L3 consent withdrawal requires a durable purge job for every retained encrypted object'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NULL;
END;
$l3_consent_withdrawal_guard$;

CREATE CONSTRAINT TRIGGER identity_l3_consent_withdrawal_requires_purge
  AFTER UPDATE OF withdrawn_at ON identity_l3_consents
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION require_identity_l3_withdrawal_purge_transition();

COMMENT ON FUNCTION require_identity_l3_withdrawal_purge_transition() IS
  'Requires consent withdrawal to revoke/withdraw all active L3 submissions and retain a durable purge job for each encrypted object in the same transaction.';
