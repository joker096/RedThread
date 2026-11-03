-- Automatic expiry is a system event, not an action by either participant.
-- Keep the event in the same transaction as the plan status transition.
ALTER TABLE date_plan_events
  ALTER COLUMN actor_id DROP NOT NULL;

ALTER TABLE date_plan_events
  DROP CONSTRAINT IF EXISTS date_plan_events_event_type_check;

ALTER TABLE date_plan_events
  ADD CONSTRAINT date_plan_events_event_type_check
  CHECK (event_type IN ('proposed', 'updated', 'confirmed', 'declined', 'cancelled', 'expired'));

COMMENT ON COLUMN date_plan_events.actor_id IS
  'Participant who initiated a user action; NULL for system-generated events such as scheduled expiry or safety-triggered cancellation.';
COMMENT ON CONSTRAINT date_plan_events_event_type_check ON date_plan_events IS
  'Date-plan lifecycle events, including system-generated expiry.';
