-- Migration 135 installed an earlier report immutability trigger that
-- rejected all reporter/target FK changes. Replace that legacy trigger with
-- migration 180's snapshot-aware guard while preserving its status state machine.
DROP TRIGGER IF EXISTS user_reports_evidence_immutable ON user_reports;

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
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'open' AND NEW.status IN ('reviewing', 'resolved', 'dismissed'))
    OR (OLD.status = 'reviewing' AND NEW.status IN ('resolved', 'dismissed'))
  ) THEN
    RAISE EXCEPTION 'invalid user report status transition'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('resolved', 'dismissed') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'terminal user report decisions are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$user_report_evidence$;

COMMENT ON FUNCTION guard_user_report_immutable_evidence() IS
  'Freezes report source facts and UUID snapshots, permits only nested FK ON DELETE SET NULL for live reporter/target references, and preserves the open/reviewing/terminal status state machine.';
