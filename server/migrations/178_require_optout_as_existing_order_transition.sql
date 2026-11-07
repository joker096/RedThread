CREATE OR REPLACE FUNCTION prevent_gift_recipient_optout_timestamp_reversal()
RETURNS trigger LANGUAGE plpgsql AS $gift_recipient_optout$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.recipient_requests_disabled_at IS NOT NULL THEN
      RAISE EXCEPTION 'gift recipient opt-out must be recorded as an update to an existing pending request'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.recipient_requests_disabled_at IS NOT NULL
     AND NEW.recipient_requests_disabled_at IS DISTINCT FROM OLD.recipient_requests_disabled_at THEN
    RAISE EXCEPTION 'gift recipient opt-out timestamp is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$gift_recipient_optout$;

DROP TRIGGER IF EXISTS gift_orders_recipient_optout_immutable ON gift_delivery_orders;
CREATE TRIGGER gift_orders_recipient_optout_immutable
  BEFORE INSERT OR UPDATE OF recipient_requests_disabled_at ON gift_delivery_orders
  FOR EACH ROW
  EXECUTE FUNCTION prevent_gift_recipient_optout_timestamp_reversal();

COMMENT ON FUNCTION prevent_gift_recipient_optout_timestamp_reversal() IS
  'Requires recipient opt-out to be a one-way update on an existing request; blocks inserts with a pre-populated opt-out marker and prevents clearing or rewriting an existing timestamp.';
