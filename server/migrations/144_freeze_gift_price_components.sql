-- Freeze every monetary component of a gift purchase, not only the
-- aggregate total. A caller must not rewrite item/fulfilment pricing while
-- leaving total_minor_units unchanged.
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

COMMENT ON FUNCTION guard_gift_delivery_order_immutable_facts() IS
  'Prevents edits to gift purchase identity, product, each item/delivery price component, aggregate price, currency, idempotency and creation facts while permitting only nested FK SET NULL cleanup of live catalog/partner references.';
