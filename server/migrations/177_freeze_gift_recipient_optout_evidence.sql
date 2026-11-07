-- Recipient opt-out is a permanent per-request fact. Protect the timestamp
-- from clearing/rewrite and create the corresponding append-only event inside
-- the same database transaction, regardless of which trusted caller sets it.
CREATE OR REPLACE FUNCTION prevent_gift_recipient_optout_timestamp_reversal()
RETURNS trigger LANGUAGE plpgsql AS $gift_recipient_optout$
BEGIN
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
  BEFORE UPDATE OF recipient_requests_disabled_at ON gift_delivery_orders
  FOR EACH ROW
  EXECUTE FUNCTION prevent_gift_recipient_optout_timestamp_reversal();

CREATE OR REPLACE FUNCTION record_gift_recipient_optout_event()
RETURNS trigger LANGUAGE plpgsql AS $gift_recipient_optout_event$
BEGIN
  IF OLD.recipient_requests_disabled_at IS NULL
     AND NEW.recipient_requests_disabled_at IS NOT NULL THEN
    INSERT INTO gift_delivery_order_events
      (order_id, actor_user_id, actor_type, event_type, from_status, to_status, metadata)
    VALUES
      (NEW.id, NEW.recipient_id, 'recipient', 'recipient_opted_out',
       OLD.status, NEW.status,
       jsonb_build_object('reason', 'recipient_opted_out'));
  END IF;
  RETURN NULL;
END;
$gift_recipient_optout_event$;

DROP TRIGGER IF EXISTS gift_orders_recipient_optout_event ON gift_delivery_orders;
CREATE TRIGGER gift_orders_recipient_optout_event
  AFTER UPDATE OF recipient_requests_disabled_at ON gift_delivery_orders
  FOR EACH ROW
  EXECUTE FUNCTION record_gift_recipient_optout_event();

-- Backfill historical opt-outs that predate the database-generated event.
INSERT INTO gift_delivery_order_events
  (order_id, actor_user_id, actor_type, event_type, from_status, to_status, metadata)
SELECT gift_order.id, gift_order.recipient_id, 'recipient', 'recipient_opted_out',
       gift_order.status, gift_order.status,
       jsonb_build_object('reason', 'recipient_opted_out', 'backfilled', TRUE)
FROM gift_delivery_orders AS gift_order
WHERE gift_order.recipient_requests_disabled_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM gift_delivery_order_events AS event
    WHERE event.order_id = gift_order.id
      AND event.event_type = 'recipient_opted_out'
      AND event.metadata->>'reason' = 'recipient_opted_out'
  );

COMMENT ON FUNCTION prevent_gift_recipient_optout_timestamp_reversal() IS
  'Prevents clearing or rewriting a recorded recipient opt-out timestamp; the timestamp is a permanent per-request invalidation fact.';
COMMENT ON FUNCTION record_gift_recipient_optout_event() IS
  'Creates an append-only recipient_opted_out event in the same transaction as the first opt-out timestamp, including for unpaid requests with no reconciliation task.';
COMMENT ON COLUMN gift_delivery_orders.recipient_requests_disabled_at IS
  'Immutable timestamp when the recipient opted out while this request was pending. Once set, the request cannot be accepted or replayed, even if future requests are enabled again.';
