-- Every new gift purchase originates from a live catalog item. The nullable
-- catalog_item_id exists only so a later catalog deletion can clear its FK
-- while catalog_item_ref preserves the original purchase provenance.
CREATE OR REPLACE FUNCTION snapshot_gift_delivery_order_references()
RETURNS trigger LANGUAGE plpgsql AS $gift_order_reference_snapshot$
DECLARE
  partner_record RECORD;
BEGIN
  IF NEW.catalog_item_id IS NULL THEN
    IF NEW.catalog_item_ref IS NOT NULL THEN
      RAISE EXCEPTION 'gift catalog item snapshot requires a live catalog item reference'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.catalog_item_ref IS NOT NULL
       AND NEW.catalog_item_ref IS DISTINCT FROM NEW.catalog_item_id THEN
      RAISE EXCEPTION 'gift catalog item snapshot must match its live reference'
        USING ERRCODE = '23514';
    END IF;
    NEW.catalog_item_ref := NEW.catalog_item_id;
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

  RETURN NEW;
END;
$gift_order_reference_snapshot$;

COMMENT ON FUNCTION snapshot_gift_delivery_order_references() IS
  'When a gift order references a catalog item, derives its immutable UUID snapshot from that live FK and rejects detached caller-supplied snapshots. Catalog-less orders remain valid with both catalog ID and snapshot NULL. Optional delivery-partner identity snapshots likewise require a live partner; later FK SET NULL actions preserve the original snapshots.';
