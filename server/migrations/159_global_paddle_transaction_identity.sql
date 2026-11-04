-- A provider transaction ID is one global financial identity. The current
-- checkout pointer and its append-only history are separate tables, so their
-- individual UNIQUE constraints do not prevent the same Paddle transaction
-- from being attributed to two accounts across a rollover.
DO $$
BEGIN
  IF EXISTS (
    SELECT transaction_id
    FROM (
      SELECT transaction_id FROM paddle_checkout_attempts WHERE transaction_id IS NOT NULL
      UNION ALL
      SELECT transaction_id FROM paddle_checkout_attempt_history WHERE transaction_id IS NOT NULL
    ) AS all_attempts
    GROUP BY transaction_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate Paddle transaction IDs exist across current and archived checkout attempts; reconcile before migration 159'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION guard_paddle_checkout_transaction_global_uniqueness()
RETURNS trigger LANGUAGE plpgsql AS $paddle_transaction_global_identity$
BEGIN
  IF NEW.transaction_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'paddle_checkout_attempts' THEN
    IF EXISTS (
      SELECT 1
      FROM paddle_checkout_attempt_history AS archived
      WHERE archived.transaction_id = NEW.transaction_id
    ) THEN
      RAISE EXCEPTION 'Paddle transaction ID already belongs to an archived checkout attempt'
        USING ERRCODE = '23505';
    END IF;
    IF EXISTS (
      SELECT 1 FROM paddle_transaction_events AS event
      WHERE event.transaction_id = NEW.transaction_id
        AND ((event.user_id IS NOT NULL AND event.user_id <> NEW.user_id)
          OR (event.plan IS NOT NULL AND event.plan <> NEW.plan))
    ) THEN
      RAISE EXCEPTION 'Paddle checkout conflicts with retained provider transaction ownership or plan'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'paddle_checkout_attempt_history' THEN
    IF EXISTS (
      SELECT 1
      FROM paddle_checkout_attempts AS current_attempt
      WHERE current_attempt.transaction_id = NEW.transaction_id
        AND NOT (
          current_attempt.user_id = NEW.user_id
          AND current_attempt.attempt_id IS NOT DISTINCT FROM NEW.attempt_id
        )
    ) THEN
      RAISE EXCEPTION 'Paddle transaction ID already belongs to another current checkout attempt'
        USING ERRCODE = '23505';
    END IF;
    IF EXISTS (
      SELECT 1 FROM paddle_transaction_events AS event
      WHERE event.transaction_id = NEW.transaction_id
        AND ((event.user_id IS NOT NULL AND event.user_id <> NEW.user_id)
          OR (event.plan IS NOT NULL AND event.plan <> NEW.plan))
    ) THEN
      RAISE EXCEPTION 'Archived Paddle checkout conflicts with retained provider transaction ownership or plan'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'paddle_transaction_events' THEN
    IF EXISTS (
      SELECT 1
      FROM (
        SELECT user_id, plan FROM paddle_checkout_attempts WHERE transaction_id = NEW.transaction_id
        UNION ALL
        SELECT user_id, plan FROM paddle_checkout_attempt_history WHERE transaction_id = NEW.transaction_id
        UNION ALL
        SELECT user_id, plan FROM paddle_transaction_events WHERE transaction_id = NEW.transaction_id
      ) AS existing
      WHERE (NEW.user_id IS NOT NULL AND existing.user_id IS NOT NULL AND existing.user_id <> NEW.user_id)
         OR (NEW.plan IS NOT NULL AND existing.plan IS NOT NULL AND existing.plan <> NEW.plan)
    ) THEN
      RAISE EXCEPTION 'Paddle transaction ledger conflicts with an existing owner or plan'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$paddle_transaction_global_identity$;

CREATE TRIGGER paddle_checkout_attempts_global_transaction_identity
  BEFORE INSERT OR UPDATE OF transaction_id ON paddle_checkout_attempts
  FOR EACH ROW
  EXECUTE FUNCTION guard_paddle_checkout_transaction_global_uniqueness();

CREATE TRIGGER paddle_checkout_attempt_history_global_transaction_identity
  BEFORE INSERT ON paddle_checkout_attempt_history
  FOR EACH ROW
  EXECUTE FUNCTION guard_paddle_checkout_transaction_global_uniqueness();

CREATE TRIGGER paddle_transaction_events_owner_identity_guard
  BEFORE INSERT ON paddle_transaction_events
  FOR EACH ROW
  EXECUTE FUNCTION guard_paddle_checkout_transaction_global_uniqueness();

COMMENT ON FUNCTION guard_paddle_checkout_transaction_global_uniqueness() IS
  'Enforces provider transaction ownership and plan consistency across current attempts, archived history, and the append-only transaction ledger; the rollover trigger may archive only its own source row.';
