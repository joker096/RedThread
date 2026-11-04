-- Paddle reports payment capture (paid) before internal transaction
-- completion. Preserve that distinction while allowing the normal paid ->
-- completed progression for the same immutable provider transaction.
ALTER TABLE paddle_transaction_events
  DROP CONSTRAINT IF EXISTS paddle_transaction_events_status_check;

ALTER TABLE paddle_transaction_events
  ADD CONSTRAINT paddle_transaction_events_status_check
  CHECK (status IN ('paid', 'completed', 'canceled'));

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
        AND NOT (
          prior.status IN ('paid', 'completed')
          AND NEW.status IN ('paid', 'completed')
        )
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

CREATE OR REPLACE FUNCTION require_linked_paddle_checkout_transaction_event()
RETURNS trigger LANGUAGE plpgsql AS $linked_checkout_event$
BEGIN
  IF NEW.status = 'linked'
     AND (
       NEW.transaction_id IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM paddle_transaction_events AS txn_event
         JOIN paddle_webhook_events AS webhook
           ON webhook.event_id = txn_event.event_id
         WHERE txn_event.transaction_id = NEW.transaction_id
           AND txn_event.user_id = NEW.user_id
           AND txn_event.plan = NEW.plan
           AND (
             (txn_event.status = 'completed' AND webhook.event_type = 'transaction.completed')
             OR (
               txn_event.status = 'paid'
               AND webhook.event_type = 'subscription.created'
               AND NEW.plan IN ('1month', '3months')
               AND txn_event.subscription_id IS NOT NULL
               AND txn_event.customer_id IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM users AS owner
                 WHERE owner.id = NEW.user_id
                   AND owner.paddle_subscription_id = txn_event.subscription_id
                   AND owner.paddle_customer_id = txn_event.customer_id
               )
             )
           )
       )
     ) THEN
    RAISE EXCEPTION 'linked Paddle checkout attempts require matching captured or completed provider transaction evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$linked_checkout_event$;

COMMENT ON FUNCTION require_linked_paddle_checkout_transaction_event() IS
  'Requires linked checkout evidence to be either a transaction.completed event or a captured paid recurring transaction tied to the same owner subscription and customer; does not mislabel subscription.created as transaction.completed.';
