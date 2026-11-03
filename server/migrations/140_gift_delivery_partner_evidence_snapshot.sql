-- Preserve delivery-partner provenance while allowing catalog/partner removal.
-- Orders remain durable; nullable live foreign keys are not the only audit record.
ALTER TABLE gift_delivery_orders
  ADD COLUMN delivery_partner_ref UUID;

UPDATE gift_delivery_orders
SET delivery_partner_ref = delivery_partner_id
WHERE delivery_partner_id IS NOT NULL;

ALTER TABLE gift_delivery_orders
  DROP CONSTRAINT IF EXISTS gift_delivery_orders_delivery_partner_id_fkey;

ALTER TABLE gift_delivery_orders
  ADD CONSTRAINT gift_delivery_orders_delivery_partner_id_fkey
  FOREIGN KEY (delivery_partner_id)
  REFERENCES gift_delivery_partners(id)
  ON DELETE SET NULL;

CREATE INDEX gift_delivery_orders_delivery_partner_ref_idx
  ON gift_delivery_orders(delivery_partner_ref)
  WHERE delivery_partner_ref IS NOT NULL;

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
     OR NEW.total_minor_units IS DISTINCT FROM OLD.total_minor_units
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.delivery_partner_ref IS DISTINCT FROM OLD.delivery_partner_ref THEN
    RAISE EXCEPTION 'gift delivery order purchase facts are immutable'
      USING ERRCODE = '55000';
  END IF;

  -- Catalog and partner cleanup may clear only their live nullable FKs through
  -- nested ON DELETE SET NULL actions. Immutable snapshots remain untouched.
  IF (NEW.catalog_item_id IS DISTINCT FROM OLD.catalog_item_id
      OR NEW.delivery_partner_id IS DISTINCT FROM OLD.delivery_partner_id)
     AND NOT (
       pg_trigger_depth() > 1
       AND (OLD.catalog_item_id IS NULL OR NEW.catalog_item_id IS NULL)
       AND (OLD.delivery_partner_id IS NULL OR NEW.delivery_partner_id IS NULL)
       AND (NEW.catalog_item_id IS NOT DISTINCT FROM OLD.catalog_item_id OR NEW.catalog_item_id IS NULL)
       AND (NEW.delivery_partner_id IS NOT DISTINCT FROM OLD.delivery_partner_id OR NEW.delivery_partner_id IS NULL)
     ) THEN
    RAISE EXCEPTION 'gift delivery order catalog/partner reference is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$gift_order_facts$;

COMMENT ON COLUMN gift_delivery_orders.delivery_partner_ref IS
  'Immutable opaque UUID snapshot of the original delivery partner; delivery_partner_id may be nulled by its FK when a partner is removed.';
