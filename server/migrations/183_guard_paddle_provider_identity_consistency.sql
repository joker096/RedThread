-- Preserve customer and subscription identity consistency across every
-- event for one Paddle transaction. An otherwise correctly owned checkout
-- must not retain a provider identity belonging to another account.
-- Freeze provider identity writes while checking retained evidence so no
-- contradictory rows can slip between the preflight and trigger activation.
LOCK TABLE paddle_transaction_events, users IN SHARE ROW EXCLUSIVE MODE;

DO $migration183$
BEGIN
  IF EXISTS (
    SELECT transaction_id
    FROM paddle_transaction_events
    GROUP BY transaction_id
    HAVING COUNT(DISTINCT customer_id) FILTER (WHERE customer_id IS NOT NULL) > 1
       OR COUNT(DISTINCT subscription_id) FILTER (WHERE subscription_id IS NOT NULL) > 1
  ) THEN
    RAISE EXCEPTION 'conflicting Paddle customer/subscription IDs already exist for one transaction; reconcile before migration 183'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT customer_id
    FROM paddle_transaction_events
    WHERE customer_id IS NOT NULL AND user_id IS NOT NULL
    GROUP BY customer_id
    HAVING COUNT(DISTINCT user_id) > 1
  ) OR EXISTS (
    SELECT subscription_id
    FROM paddle_transaction_events
    WHERE subscription_id IS NOT NULL AND user_id IS NOT NULL
    GROUP BY subscription_id
    HAVING COUNT(DISTINCT user_id) > 1
  ) THEN
    RAISE EXCEPTION 'a retained Paddle customer/subscription ID is attributed to multiple Vow accounts; reconcile before migration 183'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM paddle_transaction_events AS event
    JOIN users AS other_user
      ON other_user.id <> event.user_id
     AND (
       (event.customer_id IS NOT NULL AND other_user.paddle_customer_id = event.customer_id)
       OR (event.subscription_id IS NOT NULL AND other_user.paddle_subscription_id = event.subscription_id)
     )
    WHERE event.user_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'retained Paddle provider identity is currently assigned to a different Vow account; reconcile before migration 183'
      USING ERRCODE = '23514';
  END IF;
END;
$migration183$;

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
  IF TG_TABLE_NAME = 'paddle_transaction_events' THEN
    IF NEW.customer_id IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(
        hashtextextended('paddle-customer:' || NEW.customer_id, 0)
      );
    END IF;
    IF NEW.subscription_id IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(
        hashtextextended('paddle-subscription:' || NEW.subscription_id, 0)
      );
    END IF;
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
    -- Provider customer/subscription identities must be consistent across all
    -- events for one transaction and must never be attributed to a different
    -- Vow account than the provider identity already stored for that account.
    IF EXISTS (
      SELECT 1
      FROM paddle_transaction_events AS prior_event
      WHERE prior_event.transaction_id = NEW.transaction_id
        AND (
          (NEW.customer_id IS NOT NULL AND prior_event.customer_id IS NOT NULL
            AND prior_event.customer_id <> NEW.customer_id)
          OR (NEW.subscription_id IS NOT NULL AND prior_event.subscription_id IS NOT NULL
            AND prior_event.subscription_id <> NEW.subscription_id)
        )
    ) THEN
      RAISE EXCEPTION 'Paddle transaction conflicts with retained customer or subscription identity'
        USING ERRCODE = '23505';
    END IF;
    IF NEW.user_id IS NOT NULL AND (
      EXISTS (
        SELECT 1 FROM users AS owner
        WHERE owner.id = NEW.user_id
          AND (
            (NEW.customer_id IS NOT NULL AND owner.paddle_customer_id IS NOT NULL
              AND owner.paddle_customer_id <> NEW.customer_id)
            OR (NEW.subscription_id IS NOT NULL AND owner.paddle_subscription_id IS NOT NULL
              AND owner.paddle_subscription_id <> NEW.subscription_id)
          )
      )
      OR EXISTS (
        SELECT 1 FROM users AS other_user
        WHERE other_user.id <> NEW.user_id
          AND (
            (NEW.customer_id IS NOT NULL AND other_user.paddle_customer_id = NEW.customer_id)
            OR (NEW.subscription_id IS NOT NULL AND other_user.paddle_subscription_id = NEW.subscription_id)
          )
      )
      OR EXISTS (
        SELECT 1
        FROM paddle_transaction_events AS prior_event
        JOIN users AS prior_owner
          ON (prior_event.customer_id IS NOT NULL AND prior_owner.paddle_customer_id = prior_event.customer_id)
          OR (prior_event.subscription_id IS NOT NULL AND prior_owner.paddle_subscription_id = prior_event.subscription_id)
        WHERE prior_event.transaction_id = NEW.transaction_id
          AND prior_owner.id <> NEW.user_id
      )
      OR EXISTS (
        SELECT 1
        FROM paddle_transaction_events AS prior_event
        WHERE prior_event.user_id IS NOT NULL
          AND prior_event.user_id <> NEW.user_id
          AND (
            (NEW.customer_id IS NOT NULL AND prior_event.customer_id = NEW.customer_id)
            OR (NEW.subscription_id IS NOT NULL AND prior_event.subscription_id = NEW.subscription_id)
          )
      )
    ) THEN
      RAISE EXCEPTION 'Paddle provider customer or subscription identity belongs to a different Vow account'
        USING ERRCODE = '23505';
    END IF;
    -- A paid snapshot must come from Paddle's capture or subscription-created
    -- event. If assigned to an account, it must match a stored provider identity.
    IF NEW.status = 'paid' AND NOT EXISTS (
      SELECT 1
      FROM paddle_webhook_events AS webhook
      WHERE webhook.event_id = NEW.event_id
        AND (
          (
            webhook.event_type = 'transaction.paid'
            AND (
              NEW.user_id IS NULL
              OR EXISTS (
                SELECT 1
                FROM paddle_checkout_attempts AS attempt
                WHERE attempt.transaction_id = NEW.transaction_id
                  AND attempt.user_id = NEW.user_id
                  AND (NEW.plan IS NULL OR attempt.plan = NEW.plan)
                UNION ALL
                SELECT 1
                FROM paddle_checkout_attempt_history AS archived
                WHERE archived.transaction_id = NEW.transaction_id
                  AND archived.user_id = NEW.user_id
                  AND (NEW.plan IS NULL OR archived.plan = NEW.plan)
              )
              OR EXISTS (
                SELECT 1 FROM users AS owner
                WHERE owner.id = NEW.user_id
                  AND (
                    (NEW.customer_id IS NOT NULL AND owner.paddle_customer_id = NEW.customer_id)
                    OR (NEW.subscription_id IS NOT NULL AND owner.paddle_subscription_id = NEW.subscription_id)
                  )
                  AND (NEW.customer_id IS NULL OR owner.paddle_customer_id IS NULL
                    OR owner.paddle_customer_id = NEW.customer_id)
                  AND (NEW.subscription_id IS NULL OR owner.paddle_subscription_id IS NULL
                    OR owner.paddle_subscription_id = NEW.subscription_id)
              )
            )
          )
          OR (
            webhook.event_type = 'subscription.created'
            AND NEW.user_id IS NOT NULL
            AND NEW.plan IN ('1month', '3months')
            AND NEW.subscription_id IS NOT NULL
            AND NEW.customer_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM users AS owner
              WHERE owner.id = NEW.user_id
                AND owner.paddle_subscription_id = NEW.subscription_id
                AND owner.paddle_customer_id = NEW.customer_id
            )
          )
        )
    ) THEN
      RAISE EXCEPTION 'Paddle paid transaction evidence requires a matching capture or subscription identity'
        USING ERRCODE = '23505';
    END IF;

    -- A single Paddle transaction cannot be both completed and canceled.
    -- Keep repeated same-state notifications, but reject contradictory lifecycle facts.
    IF EXISTS (
      SELECT 1
      FROM paddle_transaction_events AS prior_event
      WHERE prior_event.transaction_id = NEW.transaction_id
        AND prior_event.status <> NEW.status
        AND NOT (
          prior_event.status IN ('paid', 'completed')
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

CREATE OR REPLACE FUNCTION guard_paddle_user_provider_identity()
RETURNS trigger LANGUAGE plpgsql AS $paddle_user_provider_identity$
BEGIN
  IF NEW.paddle_customer_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('paddle-customer:' || NEW.paddle_customer_id, 0)
    );
    IF EXISTS (
      SELECT 1
      FROM paddle_transaction_events AS event
      WHERE event.customer_id = NEW.paddle_customer_id
        AND event.user_id IS NOT NULL
        AND event.user_id <> NEW.id
    ) THEN
      RAISE EXCEPTION 'Paddle customer identity is retained for a different Vow account'
        USING ERRCODE = '23505';
    END IF;
  END IF;

  IF NEW.paddle_subscription_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('paddle-subscription:' || NEW.paddle_subscription_id, 0)
    );
    IF EXISTS (
      SELECT 1
      FROM paddle_transaction_events AS event
      WHERE event.subscription_id = NEW.paddle_subscription_id
        AND event.user_id IS NOT NULL
        AND event.user_id <> NEW.id
    ) THEN
      RAISE EXCEPTION 'Paddle subscription identity is retained for a different Vow account'
        USING ERRCODE = '23505';
    END IF;
  END IF;

  RETURN NEW;
END;
$paddle_user_provider_identity$;

DROP TRIGGER IF EXISTS users_paddle_provider_identity_guard ON users;
CREATE TRIGGER users_paddle_provider_identity_guard
  BEFORE INSERT OR UPDATE OF paddle_customer_id, paddle_subscription_id ON users
  FOR EACH ROW EXECUTE FUNCTION guard_paddle_user_provider_identity();

COMMENT ON FUNCTION guard_paddle_user_provider_identity() IS
  'Serializes Paddle customer/subscription identity assignment with transaction-ledger inserts and prevents reuse of a provider identity retained for a different Vow account.';

COMMENT ON FUNCTION guard_paddle_checkout_transaction_global_uniqueness() IS
  'Serializes provider transaction claims; verifies paid evidence provenance, cross-event customer/subscription identity consistency and account ownership; accepts transaction.paid ownership from a matching server-created checkout attempt and rejects owner, plan, provider identity and terminal lifecycle conflicts as SQLSTATE 23505 for reconciliation.';
