-- The checkout webhook intentionally promotes a provider-completed attempt
-- to either linked (lifetime entitlement attached) or reconciliation_required
-- (the provider payment exists but local entitlement linking failed). Preserve
-- identity immutability while allowing those two status-only transitions.
CREATE OR REPLACE FUNCTION prevent_paddle_checkout_attempt_identity_change()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  terminal_rollover BOOLEAN;
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'paddle checkout attempt ownership is immutable';
  END IF;

  terminal_rollover := OLD.status IN ('canceled', 'linked', 'completed')
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
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'invalid paddle checkout attempt state transition';
  END IF;

  IF NEW.plan IS DISTINCT FROM OLD.plan AND NOT terminal_rollover THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'paddle checkout attempt plan is immutable outside terminal rollover';
  END IF;

  -- completed is an intermediate provider-confirmed state: the webhook handler
  -- must be able to finish it as linked or reconciliation_required. Its
  -- attempt/transaction identity remains immutable during that status-only step.
  IF OLD.status IN ('canceled', 'linked', 'completed')
     AND (
       NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
       OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
       OR (OLD.status IN ('canceled', 'linked') AND NEW.status IS DISTINCT FROM OLD.status)
     )
     AND NOT terminal_rollover THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'paddle terminal checkout attempt identity is immutable outside permitted completion or fresh rollover';
  END IF;

  IF OLD.transaction_id IS NOT NULL
     AND NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
     AND NOT terminal_rollover THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'paddle checkout transaction identity is immutable';
  END IF;

  IF NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
     AND NOT terminal_rollover THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
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
  'Protects checkout ownership, plan, attempt and provider transaction identities; permits only the required completed -> linked/reconciliation_required status-only webhook transition and atomic terminal rollover to a fresh creating attempt.';
