-- A recipient opt-out marker describes invalidation of a request that was
-- actually awaiting the recipient's decision. Do not allow arbitrary SQL to
-- attach this evidence to an expired, accepted, declined or delivered order.
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

  IF OLD.recipient_requests_disabled_at IS NULL
     AND NEW.recipient_requests_disabled_at IS NOT NULL
     AND (
       OLD.status <> 'awaiting_recipient_consent'
       OR NEW.status <> 'awaiting_recipient_consent'
     ) THEN
    RAISE EXCEPTION 'gift recipient opt-out evidence may only invalidate an existing request awaiting recipient consent'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$gift_recipient_optout$;

COMMENT ON FUNCTION prevent_gift_recipient_optout_timestamp_reversal() IS
  'Requires recipient opt-out to be a one-way timestamp update on an existing awaiting_recipient_consent order; rejects forged insert markers and opt-outs on expired, accepted, declined or delivered orders.';
