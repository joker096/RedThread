-- Reports are safety evidence, not disposable child rows of either account.
-- Preserve opaque reporter/target UUID snapshots while allowing the live user
-- FKs to be nulled when an account is erased.
ALTER TABLE user_reports
  ALTER COLUMN reporter_id DROP NOT NULL,
  ALTER COLUMN reported_user_id DROP NOT NULL,
  ADD COLUMN reporter_ref UUID,
  ADD COLUMN reported_user_ref UUID;

UPDATE user_reports
SET reporter_ref = reporter_id,
    reported_user_ref = reported_user_id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM user_reports
    WHERE reporter_ref IS NULL OR reported_user_ref IS NULL
       OR reporter_ref = reported_user_ref
  ) THEN
    RAISE EXCEPTION 'user report identity snapshots could not be established; reconcile report evidence before migration 180'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE user_reports
  ALTER COLUMN reporter_ref SET NOT NULL,
  ALTER COLUMN reported_user_ref SET NOT NULL,
  DROP CONSTRAINT IF EXISTS user_reports_reporter_id_fkey,
  DROP CONSTRAINT IF EXISTS user_reports_reported_user_id_fkey,
  ADD CONSTRAINT user_reports_reporter_id_fkey
    FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT user_reports_reported_user_id_fkey
    FOREIGN KEY (reported_user_id) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT user_reports_identity_snapshot_distinct
    CHECK (reporter_ref <> reported_user_ref);

CREATE OR REPLACE FUNCTION snapshot_user_report_references()
RETURNS trigger LANGUAGE plpgsql AS $user_report_snapshot$
BEGIN
  IF NEW.reporter_id IS NULL OR NEW.reported_user_id IS NULL THEN
    RAISE EXCEPTION 'new user reports require live reporter and target accounts'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.reporter_ref IS NOT NULL AND NEW.reporter_ref IS DISTINCT FROM NEW.reporter_id THEN
    RAISE EXCEPTION 'user report reporter snapshot must match the live reporter'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.reported_user_ref IS NOT NULL AND NEW.reported_user_ref IS DISTINCT FROM NEW.reported_user_id THEN
    RAISE EXCEPTION 'user report target snapshot must match the live target'
      USING ERRCODE = '23514';
  END IF;
  NEW.reporter_ref := NEW.reporter_id;
  NEW.reported_user_ref := NEW.reported_user_id;
  RETURN NEW;
END;
$user_report_snapshot$;

DROP TRIGGER IF EXISTS user_reports_snapshot_references ON user_reports;
CREATE TRIGGER user_reports_snapshot_references
  BEFORE INSERT ON user_reports
  FOR EACH ROW
  EXECUTE FUNCTION snapshot_user_report_references();

CREATE OR REPLACE FUNCTION guard_user_report_immutable_evidence()
RETURNS trigger LANGUAGE plpgsql AS $user_report_evidence$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'user report safety evidence cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.reporter_ref IS DISTINCT FROM OLD.reporter_ref
     OR NEW.reported_user_ref IS DISTINCT FROM OLD.reported_user_ref
     OR NEW.category IS DISTINCT FROM OLD.category
     OR NEW.details IS DISTINCT FROM OLD.details
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'user report source evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF (NEW.reporter_id IS DISTINCT FROM OLD.reporter_id
      OR NEW.reported_user_id IS DISTINCT FROM OLD.reported_user_id)
     AND NOT (
       pg_trigger_depth() > 1
       AND (
         NEW.reporter_id IS NOT DISTINCT FROM OLD.reporter_id
         OR (OLD.reporter_id IS NOT NULL AND NEW.reporter_id IS NULL)
       )
       AND (
         NEW.reported_user_id IS NOT DISTINCT FROM OLD.reported_user_id
         OR (OLD.reported_user_id IS NOT NULL AND NEW.reported_user_id IS NULL)
       )
     ) THEN
    RAISE EXCEPTION 'user report live account references may only be nulled by account deletion'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('resolved', 'dismissed') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'terminal user report decisions are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$user_report_evidence$;

DROP TRIGGER IF EXISTS user_reports_immutable_evidence ON user_reports;
CREATE TRIGGER user_reports_immutable_evidence
  BEFORE UPDATE OR DELETE ON user_reports
  FOR EACH ROW
  EXECUTE FUNCTION guard_user_report_immutable_evidence();

CREATE OR REPLACE FUNCTION prevent_user_report_truncate()
RETURNS trigger LANGUAGE plpgsql AS $user_report_truncate$
BEGIN
  RAISE EXCEPTION 'user report safety evidence cannot be truncated'
    USING ERRCODE = '55000';
END;
$user_report_truncate$;

DROP TRIGGER IF EXISTS user_reports_no_truncate ON user_reports;
CREATE TRIGGER user_reports_no_truncate
  BEFORE TRUNCATE ON user_reports
  FOR EACH STATEMENT
  EXECUTE FUNCTION prevent_user_report_truncate();

CREATE OR REPLACE FUNCTION require_user_report_status_audit()
RETURNS trigger LANGUAGE plpgsql AS $user_report_status_audit$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT EXISTS (
       SELECT 1
       FROM moderation_audit_log AS audit
       JOIN users AS moderator ON moderator.id = audit.moderator_ref
       WHERE audit.target_type = 'user_report'
         AND audit.target_id = NEW.id::text
         AND audit.details->>'newStatus' = NEW.status
         AND audit.details->>'targetUserId' = NEW.reported_user_ref::text
         AND audit.details->>'category' = NEW.category
         AND (
           (audit.action = 'review' AND NEW.status = 'reviewing')
           OR (audit.action = 'dismiss' AND NEW.status = 'dismissed')
           OR (audit.action IN ('resolve', 'suspend_user') AND NEW.status = 'resolved')
         )
         AND moderator.status = 'active'
         AND moderator.role IN ('admin', 'moderator')
     ) THEN
    RAISE EXCEPTION 'user report status transition requires matching active moderator audit evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$user_report_status_audit$;

COMMENT ON TABLE user_reports IS
  'Retained safety reports with immutable reporter/target UUID snapshots. Live user FKs may be nulled on account deletion; source report evidence cannot be updated, deleted or truncated.';
COMMENT ON COLUMN user_reports.reporter_ref IS
  'Opaque immutable reporter UUID snapshot; no FK so account erasure cannot cascade-delete or erase report provenance.';
COMMENT ON COLUMN user_reports.reported_user_ref IS
  'Opaque immutable reported-account UUID snapshot; no FK so account erasure cannot cascade-delete or erase report provenance.';
