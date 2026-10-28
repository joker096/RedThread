-- Durable outbox for gift orders whose recipient opted out while payment may still be active.
-- This records required work but does not assert that a payment was voided or refunded.
CREATE TABLE IF NOT EXISTS gift_payment_reconciliation_tasks (
  id BIGSERIAL PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES gift_delivery_orders(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (reason IN ('recipient_opted_out')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (order_id, reason),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS gift_payment_reconciliation_due_idx
  ON gift_payment_reconciliation_tasks (next_attempt_at, created_at)
  WHERE status IN ('pending', 'failed');

COMMENT ON TABLE gift_payment_reconciliation_tasks IS
  'Durable outbox of gift payment states requiring provider reconciliation. A task is not proof of cancellation or refund; workers must confirm the provider and update the order idempotently.';

-- A confirmed refund must be reflected by the terminal refunded order state, and vice versa.
-- Fail visibly rather than silently rewriting any legacy financial records.
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM gift_delivery_orders
    WHERE (payment_status = 'refunded' AND status <> 'refunded')
       OR (status = 'refunded' AND payment_status <> 'refunded')
  ) THEN
    RAISE EXCEPTION
      'gift order refund state reconciliation required before migration 043: order and payment statuses disagree';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'gift_orders_refunded_status_payment_consistency'
      AND conrelid = 'gift_delivery_orders'::regclass
  ) THEN
    ALTER TABLE gift_delivery_orders
      ADD CONSTRAINT gift_orders_refunded_status_payment_consistency
      CHECK ((status = 'refunded') = (payment_status = 'refunded'));
  END IF;
END $migration$;

ALTER TABLE gift_delivery_order_events
  DROP CONSTRAINT IF EXISTS gift_delivery_order_events_event_type_check;

ALTER TABLE gift_delivery_order_events
  ADD CONSTRAINT gift_delivery_order_events_event_type_check
  CHECK (event_type IN (
    'request_created', 'accepted', 'declined', 'expired', 'address_verified',
    'fulfilment_authorized', 'dispatched', 'delivered', 'delivery_failed',
    'cancelled', 'consent_withdrawn', 'blocked', 'reported',
    'payment_authorized', 'payment_captured', 'payment_voided',
    'payment_reconciliation_required', 'refund_requested', 'refunded', 'safety_hold'
  ));

COMMENT ON CONSTRAINT gift_delivery_order_events_event_type_check
  ON gift_delivery_order_events IS
  'Permitted gift-order audit events, including explicit consent withdrawal and payment reconciliation requirements.';
