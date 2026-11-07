-- A Paddle transaction has one terminal lifecycle: completed or canceled.
-- Detect historical contradictions before enforcing the invariant for new events.
DO $$
BEGIN
  IF EXISTS (
    SELECT transaction_id
    FROM paddle_transaction_events
    GROUP BY transaction_id
    HAVING COUNT(DISTINCT status) > 1
  ) THEN
    RAISE EXCEPTION 'conflicting completed/canceled Paddle transaction events already exist; reconcile before migration 163'
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
    -- A single Paddle transaction cannot be both completed and canceled.
    -- Keep repeated same-state notifications, but reject contradictory lifecycle facts.
    IF EXISTS (
      SELECT 1
      FROM paddle_transaction_events AS prior
      WHERE prior.transaction_id = NEW.transaction_id
        AND prior.status <> NEW.status
    ) THEN
      RAISE EXCEPTION 'Paddle transaction lifecycle conflicts with retained completed/canceled state'
        USING ERRCODE = '23505';
    END IF;
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




DROP TRIGGER IF EXISTS paddle_transaction_events_owner_identity_guard ON paddle_transaction_events;
CREATE TRIGGER paddle_transaction_events_owner_identity_guard
  BEFORE INSERT ON paddle_transaction_events
  FOR EACH ROW
  EXECUTE FUNCTION guard_paddle_checkout_transaction_global_uniqueness();

COMMENT ON FUNCTION guard_paddle_checkout_transaction_global_uniqueness() IS
  'Serializes provider transaction claims; rejects cross-source owner/plan conflicts and contradictory completed/canceled lifecycle states as SQLSTATE 23505 so webhook processing queues reconciliation.';
