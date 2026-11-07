-- Treat global Paddle transaction owner/plan collisions as identity
-- conflicts. The webhook processor already preserves the event dedupe row and
-- moves only the exact affected checkout into reconciliation for SQLSTATE 23505.
CREATE OR REPLACE FUNCTION guard_paddle_checkout_transaction_global_uniqueness()
RETURNS trigger LANGUAGE plpgsql AS $paddle_transaction_global_identity$
BEGIN
  IF NEW.transaction_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- The three tables have independent indexes, so a read-before-write check
  -- alone races when two sessions claim the same provider ID concurrently.
  -- Serialize every cross-table claim for this transaction until commit.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('paddle-transaction:' || NEW.transaction_id, 0)
  );

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
        USING ERRCODE = '23505';
    END IF;
  ELSIF TG_TABLE_NAME = 'paddle_checkout_attempt_history' THEN
    IF EXISTS (
      SELECT 1
      FROM paddle_checkout_attempts AS current_attempt
      WHERE current_attempt.transaction_id = NEW.transaction_id
        AND NOT (
          current_attempt.user_id = NEW.user_id
          AND current_attempt.attempt_id IS NOT DISTINCT FROM NEW.attempt_id
          AND current_attempt.plan = NEW.plan
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
        USING ERRCODE = '23505';
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
        USING ERRCODE = '23505';
    END IF;
  END IF;

  RETURN NEW;
END;
$paddle_transaction_global_identity$;



DROP TRIGGER IF EXISTS paddle_checkout_attempts_global_transaction_identity ON paddle_checkout_attempts;
CREATE TRIGGER paddle_checkout_attempts_global_transaction_identity
  BEFORE INSERT OR UPDATE OF transaction_id, user_id, plan ON paddle_checkout_attempts
  FOR EACH ROW
  EXECUTE FUNCTION guard_paddle_checkout_transaction_global_uniqueness();

COMMENT ON FUNCTION guard_paddle_checkout_transaction_global_uniqueness() IS
  'Serializes provider transaction claims with a transaction-scoped advisory lock and raises SQLSTATE 23505 for cross-source owner/plan identity collisions so webhook processing preserves the event and queues exact-attempt reconciliation.';
