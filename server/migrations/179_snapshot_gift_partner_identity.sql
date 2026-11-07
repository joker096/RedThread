-- The UUID reference alone is not a meaningful partner identity after the
-- live partner row is removed. Preserve its stable key and display name too.
ALTER TABLE gift_delivery_orders
  ADD COLUMN delivery_partner_key_snapshot VARCHAR(100),
  ADD COLUMN delivery_partner_name_snapshot VARCHAR(160);

UPDATE gift_delivery_orders AS gift_order
SET delivery_partner_ref = COALESCE(gift_order.delivery_partner_ref, gift_order.delivery_partner_id),
    delivery_partner_key_snapshot = partner.partner_key,
    delivery_partner_name_snapshot = partner.display_name
FROM gift_delivery_partners AS partner
WHERE partner.id = gift_order.delivery_partner_id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM gift_delivery_orders
    WHERE delivery_partner_ref IS NOT NULL
      AND (
        delivery_partner_key_snapshot IS NULL
        OR btrim(delivery_partner_key_snapshot) = ''
        OR delivery_partner_name_snapshot IS NULL
        OR btrim(delivery_partner_name_snapshot) = ''
      )
  ) THEN
    RAISE EXCEPTION 'gift delivery partner provenance requires manual reconciliation before migration 179: a partner row was removed before its identity could be snapshotted'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE gift_delivery_orders
  ADD CONSTRAINT gift_orders_delivery_partner_snapshot_complete
  CHECK (
    delivery_partner_ref IS NULL
    OR (
      delivery_partner_key_snapshot IS NOT NULL
      AND btrim(delivery_partner_key_snapshot) <> ''
      AND delivery_partner_name_snapshot IS NOT NULL
      AND btrim(delivery_partner_name_snapshot) <> ''
    )
  );

CREATE OR REPLACE FUNCTION snapshot_gift_delivery_order_references()
RETURNS trigger LANGUAGE plpgsql AS $gift_order_reference_snapshot$
DECLARE
  partner_record RECORD;
BEGIN
  IF NEW.catalog_item_id IS NOT NULL
     AND NEW.catalog_item_ref IS NOT NULL
     AND NEW.catalog_item_ref IS DISTINCT FROM NEW.catalog_item_id THEN
    RAISE EXCEPTION 'gift catalog item snapshot must match its live reference'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.delivery_partner_id IS NOT NULL THEN
    SELECT partner_key, display_name
    INTO partner_record
    FROM gift_delivery_partners
    WHERE id = NEW.delivery_partner_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'gift delivery partner must exist when purchase provenance is created'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.delivery_partner_ref IS NOT NULL
       AND NEW.delivery_partner_ref IS DISTINCT FROM NEW.delivery_partner_id THEN
      RAISE EXCEPTION 'gift delivery partner UUID snapshot must match its live reference'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.delivery_partner_key_snapshot IS NOT NULL
       AND NEW.delivery_partner_key_snapshot IS DISTINCT FROM partner_record.partner_key THEN
      RAISE EXCEPTION 'gift delivery partner key snapshot must match its live reference'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.delivery_partner_name_snapshot IS NOT NULL
       AND NEW.delivery_partner_name_snapshot IS DISTINCT FROM partner_record.display_name THEN
      RAISE EXCEPTION 'gift delivery partner name snapshot must match its live reference'
        USING ERRCODE = '23514';
    END IF;
    NEW.delivery_partner_ref := NEW.delivery_partner_id;
    NEW.delivery_partner_key_snapshot := partner_record.partner_key;
    NEW.delivery_partner_name_snapshot := partner_record.display_name;
  ELSIF NEW.delivery_partner_ref IS NOT NULL
     OR NEW.delivery_partner_key_snapshot IS NOT NULL
     OR NEW.delivery_partner_name_snapshot IS NOT NULL THEN
    RAISE EXCEPTION 'gift delivery partner snapshots require a live partner at order creation'
      USING ERRCODE = '23514';
  END IF;
  NEW.catalog_item_ref := COALESCE(NEW.catalog_item_ref, NEW.catalog_item_id);
  RETURN NEW;
END;
$gift_order_reference_snapshot$;

CREATE OR REPLACE FUNCTION guard_gift_delivery_order_immutable_facts()
RETURNS trigger LANGUAGE plpgsql AS $gift_order_facts$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.public_reference IS DISTINCT FROM OLD.public_reference
     OR NEW.match_id IS DISTINCT FROM OLD.match_id
     OR NEW.sender_id IS DISTINCT FROM OLD.sender_id
     OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
     OR NEW.product_name_snapshot IS DISTINCT FROM OLD.product_name_snapshot
     OR NEW.product_category IS DISTINCT FROM OLD.product_category
     OR NEW.item_price_minor_units IS DISTINCT FROM OLD.item_price_minor_units
     OR NEW.delivery_fee_minor_units IS DISTINCT FROM OLD.delivery_fee_minor_units
     OR NEW.delivery_fee_currency IS DISTINCT FROM OLD.delivery_fee_currency
     OR NEW.total_minor_units IS DISTINCT FROM OLD.total_minor_units
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.catalog_item_ref IS DISTINCT FROM OLD.catalog_item_ref
     OR NEW.delivery_partner_ref IS DISTINCT FROM OLD.delivery_partner_ref
     OR NEW.delivery_partner_key_snapshot IS DISTINCT FROM OLD.delivery_partner_key_snapshot
     OR NEW.delivery_partner_name_snapshot IS DISTINCT FROM OLD.delivery_partner_name_snapshot THEN
    RAISE EXCEPTION 'gift delivery order purchase facts are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF (NEW.catalog_item_id IS DISTINCT FROM OLD.catalog_item_id
      OR NEW.delivery_partner_id IS DISTINCT FROM OLD.delivery_partner_id)
     AND NOT (
       pg_trigger_depth() > 1
       AND (
         NEW.catalog_item_id IS NOT DISTINCT FROM OLD.catalog_item_id
         OR (OLD.catalog_item_id IS NOT NULL AND NEW.catalog_item_id IS NULL)
       )
       AND (
         NEW.delivery_partner_id IS NOT DISTINCT FROM OLD.delivery_partner_id
         OR (OLD.delivery_partner_id IS NOT NULL AND NEW.delivery_partner_id IS NULL)
       )
     ) THEN
    RAISE EXCEPTION 'gift delivery order catalog/partner reference is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$gift_order_facts$;

COMMENT ON COLUMN gift_delivery_orders.delivery_partner_key_snapshot IS
  'Immutable stable partner key copied at purchase creation; survives deletion of the live delivery partner row.';
COMMENT ON COLUMN gift_delivery_orders.delivery_partner_name_snapshot IS
  'Immutable partner display-name snapshot copied at purchase creation; the opaque UUID reference alone is not sufficient provenance after partner deletion.';
COMMENT ON FUNCTION snapshot_gift_delivery_order_references() IS
  'Snapshots catalog UUID and delivery-partner UUID, stable key, and display name at order creation; supplied snapshot values must match the live partner.';
COMMENT ON FUNCTION guard_gift_delivery_order_immutable_facts() IS
  'Prevents edits to gift purchase identity, product, each item/delivery price component, aggregate price, currency, partner provenance, idempotency and creation facts while permitting only nested FK SET NULL cleanup of live catalog/partner references.';
