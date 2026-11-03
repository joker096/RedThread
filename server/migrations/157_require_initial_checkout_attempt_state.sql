-- Checkout attempts are created by the application before Paddle has issued a
-- transaction. A direct INSERT must not forge a completed/linked/canceled
-- provider state and then use that row as entitlement or reconciliation proof.
CREATE OR REPLACE FUNCTION require_initial_paddle_checkout_attempt_state()
RETURNS trigger LANGUAGE plpgsql AS $checkout_attempt_initial_state$
BEGIN
  IF NEW.status IS DISTINCT FROM 'creating'
     OR NEW.transaction_id IS NOT NULL THEN
    RAISE EXCEPTION 'new Paddle checkout attempts must start in creating state without a provider transaction'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$checkout_attempt_initial_state$;

CREATE TRIGGER paddle_checkout_attempts_initial_state_guard
  BEFORE INSERT ON paddle_checkout_attempts
  FOR EACH ROW
  EXECUTE FUNCTION require_initial_paddle_checkout_attempt_state();

COMMENT ON FUNCTION require_initial_paddle_checkout_attempt_state() IS
  'Requires every new checkout attempt to begin as an unlinked creating attempt; provider completion/linkage must pass through the guarded state transitions.';
