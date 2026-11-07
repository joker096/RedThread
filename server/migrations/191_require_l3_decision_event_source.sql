-- Decision events are projections of the guarded submission state machine,
-- not an independently writable audit stream. The only supported insert path
-- is record_identity_l3_submission_event() running as a nested submission
-- trigger; direct SQL inserts would otherwise forge review/approval history.
CREATE OR REPLACE FUNCTION require_identity_l3_decision_event_source()
RETURNS trigger LANGUAGE plpgsql AS $l3_decision_event_source$
BEGIN
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'identity L3 decision events may only be emitted by guarded submission transitions'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$l3_decision_event_source$;

CREATE TRIGGER identity_l3_decision_events_source_insert_guard
  BEFORE INSERT ON identity_l3_decision_events
  FOR EACH ROW
  EXECUTE FUNCTION require_identity_l3_decision_event_source();

COMMENT ON FUNCTION require_identity_l3_decision_event_source() IS
  'Allows L3 decision-event inserts only from the nested record_identity_l3_submission_event trigger; blocks direct SQL fabrication of approval, rejection, withdrawal and processing audit history.';
