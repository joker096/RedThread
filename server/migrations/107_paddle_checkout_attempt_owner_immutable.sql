-- A terminal checkout row may be reused for a fresh attempt, but its account
-- ownership is permanent. Otherwise an UPDATE could rotate attempt_id while
-- transferring the durable row (and any transaction history) to another user.
CREATE OR REPLACE FUNCTION prevent_paddle_checkout_attempt_identity_change()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION
      USING ERRCODE = '23514',
            MESSAGE = 'paddle checkout attempt ownership is immutable';
  END IF;

  IF NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
     AND NOT (
       OLD.status IN ('canceled', 'linked')
       AND NEW.status = 'creating'
       AND NEW.transaction_id IS NULL
       AND NEW.attempt_id IS NOT NULL
       AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     ) THEN
    RAISE EXCEPTION
      USING ERRCODE = '23514',
            MESSAGE = 'paddle checkout attempt identity is immutable outside terminal rollover';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS paddle_checkout_attempts_identity_immutable ON paddle_checkout_attempts;
CREATE TRIGGER paddle_checkout_attempts_identity_immutable
  BEFORE UPDATE OF attempt_id, user_id ON paddle_checkout_attempts
  FOR EACH ROW
  EXECUTE FUNCTION prevent_paddle_checkout_attempt_identity_change();

COMMENT ON FUNCTION prevent_paddle_checkout_attempt_identity_change() IS
  'Keeps checkout attempt identity and account ownership immutable; permits a new identity only when the same account atomically reuses a canceled or linked row for a fresh creating attempt.';
