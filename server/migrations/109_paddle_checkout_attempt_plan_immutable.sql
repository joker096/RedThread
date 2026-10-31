-- Terminal attempts are immutable. Reuse is allowed only as one atomic
-- transition to a fresh creating attempt with a new ID and no old transaction.
-- Once a provider transaction ID is attached, it cannot be swapped or cleared.
CREATE OR REPLACE FUNCTION prevent_paddle_checkout_attempt_identity_change()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  terminal_rollover BOOLEAN;
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION
      USING ERRCODE = '23514',
            MESSAGE = 'paddle checkout attempt ownership is immutable';
  END IF;

  terminal_rollover := OLD.status IN ('canceled', 'linked')
    AND NEW.status = 'creating'
    AND NEW.attempt_id IS NOT NULL
    AND NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    AND NEW.transaction_id IS NULL;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT terminal_rollover
     AND NOT (
       (OLD.status = 'creating' AND NEW.status IN ('pending', 'completed', 'canceled', 'reconciliation_required'))
       OR (OLD.status = 'pending' AND NEW.status IN ('completed', 'canceled', 'reconciliation_required'))
       OR (OLD.status = 'completed' AND NEW.status IN ('linked', 'reconciliation_required'))
       OR (OLD.status = 'reconciliation_required' AND NEW.status IN ('completed', 'canceled', 'linked'))
     ) THEN
    RAISE EXCEPTION
      USING ERRCODE = '23514',
            MESSAGE = 'invalid paddle checkout attempt state transition';
  END IF;


  IF NEW.plan IS DISTINCT FROM OLD.plan AND NOT terminal_rollover THEN
    RAISE EXCEPTION
      USING ERRCODE = '23514',
            MESSAGE = 'paddle checkout attempt plan is immutable outside terminal rollover';
  END IF;

  IF OLD.status IN ('canceled', 'linked')
     AND (
       NEW.status IS DISTINCT FROM OLD.status
       OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
       OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
     )
     AND NOT terminal_rollover THEN
    RAISE EXCEPTION
      USING ERRCODE = '23514',
            MESSAGE = 'paddle terminal checkout attempt is immutable outside fresh rollover';
  END IF;

  IF OLD.transaction_id IS NOT NULL
     AND NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
     AND NOT terminal_rollover THEN
    RAISE EXCEPTION
      USING ERRCODE = '23514',
            MESSAGE = 'paddle checkout transaction identity is immutable';
  END IF;

  IF NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
     AND NOT terminal_rollover THEN
    RAISE EXCEPTION
      USING ERRCODE = '23514',
            MESSAGE = 'paddle checkout attempt identity is immutable outside terminal rollover';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS paddle_checkout_attempts_identity_immutable ON paddle_checkout_attempts;
CREATE TRIGGER paddle_checkout_attempts_identity_immutable
  BEFORE UPDATE OF attempt_id, user_id, status, transaction_id, plan ON paddle_checkout_attempts
  FOR EACH ROW
  EXECUTE FUNCTION prevent_paddle_checkout_attempt_identity_change();

COMMENT ON FUNCTION prevent_paddle_checkout_attempt_identity_change() IS
  'Protects checkout account, attempt and provider transaction identities; terminal rows may only be atomically reused as a fresh creating attempt with a new ID and cleared transaction.';
