-- Enforce global uniqueness of live Paddle customer/subscription identities
-- at the database boundary, including assignments made before any transaction
-- event has been retained. Serialize claims by provider ID so concurrent writes
-- cannot both pass a read-before-write check.
LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE;

DO $migration187$
BEGIN
  IF EXISTS (
    SELECT paddle_customer_id
    FROM users
    WHERE paddle_customer_id IS NOT NULL
    GROUP BY paddle_customer_id
    HAVING COUNT(*) > 1
  ) OR EXISTS (
    SELECT paddle_subscription_id
    FROM users
    WHERE paddle_subscription_id IS NOT NULL
    GROUP BY paddle_subscription_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate live Paddle customer/subscription identities already exist; reconcile before migration 187'
      USING ERRCODE = '23514';
  END IF;
END;
$migration187$;

CREATE OR REPLACE FUNCTION guard_paddle_user_provider_identity()
RETURNS trigger LANGUAGE plpgsql AS $paddle_user_provider_identity$
BEGIN
  IF NEW.paddle_customer_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('paddle-customer:' || NEW.paddle_customer_id, 0)
    );
    IF EXISTS (
      SELECT 1
      FROM users AS other_user
      WHERE other_user.id <> NEW.id
        AND other_user.paddle_customer_id = NEW.paddle_customer_id
    ) THEN
      RAISE EXCEPTION 'Paddle customer identity is already assigned to another Vow account'
        USING ERRCODE = '23505';
    END IF;
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
      FROM users AS other_user
      WHERE other_user.id <> NEW.id
        AND other_user.paddle_subscription_id = NEW.paddle_subscription_id
    ) THEN
      RAISE EXCEPTION 'Paddle subscription identity is already assigned to another Vow account'
        USING ERRCODE = '23505';
    END IF;
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

COMMENT ON FUNCTION guard_paddle_user_provider_identity() IS
  'Serializes Paddle customer/subscription identity assignment and rejects IDs already live on another account or retained for another account in immutable transaction evidence.';
