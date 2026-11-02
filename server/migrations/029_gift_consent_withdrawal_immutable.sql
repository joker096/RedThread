-- Once recipient consent is withdrawn, the audit timestamp is immutable.
-- This prevents clearing or rewriting the marker to bypass migration 028's
-- terminal-state CHECK constraint. Payment reconciliation remains separate.
CREATE OR REPLACE FUNCTION prevent_gift_consent_withdrawal_reversal()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.consent_withdrawn_at IS NOT NULL
     AND NEW.consent_withdrawn_at IS DISTINCT FROM OLD.consent_withdrawn_at THEN
    RAISE EXCEPTION
      USING ERRCODE = '23514',
            MESSAGE = 'gift consent withdrawal timestamp is immutable';
  END IF;
  RETURN NEW;
END;
$function$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'gift_delivery_orders'::regclass
      AND tgname = 'gift_orders_consent_withdrawal_immutable'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER gift_orders_consent_withdrawal_immutable
      BEFORE UPDATE OF consent_withdrawn_at ON gift_delivery_orders
      FOR EACH ROW
      EXECUTE FUNCTION prevent_gift_consent_withdrawal_reversal();
  END IF;
END $$;

COMMENT ON FUNCTION prevent_gift_consent_withdrawal_reversal() IS
  'Prevents clearing or rewriting a recorded gift consent-withdrawal timestamp; paired with gift_orders_withdrawn_consent_cannot_progress to make withdrawal terminal.';
