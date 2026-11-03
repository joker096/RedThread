-- A linked checkout is a terminal financial fact, not a caller-selectable
-- status. It must be backed by the retained transaction.completed webhook
-- ledger row for the same user, plan and provider transaction.
CREATE OR REPLACE FUNCTION require_linked_paddle_checkout_transaction_event()
RETURNS trigger LANGUAGE plpgsql AS $linked_checkout_event$
BEGIN
  IF NEW.status = 'linked'
     AND (
       NEW.transaction_id IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM paddle_transaction_events AS transaction
         JOIN paddle_webhook_events AS webhook
           ON webhook.event_id = transaction.event_id
          AND webhook.event_type = 'transaction.completed'
         WHERE transaction.transaction_id = NEW.transaction_id
           AND transaction.user_id = NEW.user_id
           AND transaction.plan = NEW.plan
           AND transaction.status = 'completed'
       )
     ) THEN
    RAISE EXCEPTION 'linked Paddle checkout attempts require matching completed provider transaction evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$linked_checkout_event$;

CREATE CONSTRAINT TRIGGER paddle_checkout_attempts_linked_transaction_evidence_guard
  AFTER UPDATE ON paddle_checkout_attempts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION require_linked_paddle_checkout_transaction_event();

-- History rows may be inserted only by the nested archive trigger in
-- migration 135, and only when they exactly snapshot the current terminal row.
CREATE OR REPLACE FUNCTION require_paddle_checkout_history_archive_source()
RETURNS trigger LANGUAGE plpgsql AS $checkout_history_source$
BEGIN
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'Paddle checkout history may only be created by terminal rollover'
      USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM paddle_checkout_attempts AS current_attempt
    WHERE current_attempt.user_id = NEW.user_id
      AND current_attempt.attempt_id IS NOT DISTINCT FROM NEW.attempt_id
      AND current_attempt.transaction_id IS NOT DISTINCT FROM NEW.transaction_id
      AND current_attempt.plan = NEW.plan
      AND current_attempt.status = NEW.status
      AND current_attempt.created_at = NEW.created_at
      AND current_attempt.updated_at = NEW.updated_at
  ) THEN
    RAISE EXCEPTION 'Paddle checkout history must exactly snapshot its terminal current attempt'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$checkout_history_source$;

CREATE TRIGGER paddle_checkout_attempt_history_archive_source_guard
  BEFORE INSERT ON paddle_checkout_attempt_history
  FOR EACH ROW
  EXECUTE FUNCTION require_paddle_checkout_history_archive_source();

COMMENT ON FUNCTION require_linked_paddle_checkout_transaction_event() IS
  'Requires every checkout attempt transition to linked to have a matching completed transaction event from the retained Paddle webhook ledger.';
COMMENT ON FUNCTION require_paddle_checkout_history_archive_source() IS
  'Allows checkout history inserts only from the nested terminal-rollover trigger and only as an exact snapshot of the current terminal attempt.';
