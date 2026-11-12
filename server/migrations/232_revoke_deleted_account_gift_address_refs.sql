-- A delivered gift keeps its immutable delivery/payment evidence, not a live pointer
-- to the recipient's private address. Account tombstoning revokes every such pointer.
-- The original 019 CHECK required an address pointer forever after verification;
-- relax it only for completed deliveries so post-delivery erasure is possible.
DO $migration232_drop_legacy_address_check$
DECLARE
  constraint_row RECORD;
BEGIN
  FOR constraint_row IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'gift_delivery_orders'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%address_vault_ref%'
      AND pg_get_constraintdef(oid) ILIKE '%address_verified_at%'
      AND pg_get_constraintdef(oid) ILIKE '%delivered%'
  LOOP
    EXECUTE format('ALTER TABLE gift_delivery_orders DROP CONSTRAINT %I', constraint_row.conname);
  END LOOP;
END;
$migration232_drop_legacy_address_check$;

ALTER TABLE gift_delivery_orders
  ADD CONSTRAINT gift_orders_address_required_until_delivery
  CHECK (
    status NOT IN ('address_verified', 'fulfilment_authorized', 'dispatched')
    OR (address_vault_ref IS NOT NULL AND address_verified_at IS NOT NULL)
  ) NOT VALID;

COMMENT ON CONSTRAINT gift_orders_address_required_until_delivery ON gift_delivery_orders IS
  'A verified address is required while fulfilment is pending/in progress; a completed delivery may revoke its private address pointer while retaining delivery evidence.';

CREATE OR REPLACE FUNCTION revoke_deleted_account_gift_address_refs()
RETURNS trigger
LANGUAGE plpgsql
AS $gift_address_erasure$
BEGIN
  IF NEW.status = 'deleted' AND OLD.status IS DISTINCT FROM 'deleted' THEN
    UPDATE gift_delivery_orders
    SET address_vault_ref = NULL,
        updated_at = statement_timestamp()
    WHERE (sender_id = NEW.id OR recipient_id = NEW.id)
      AND address_vault_ref IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$gift_address_erasure$;

DROP TRIGGER IF EXISTS users_revoke_deleted_account_gift_address_refs ON users;
CREATE TRIGGER users_revoke_deleted_account_gift_address_refs
  AFTER UPDATE OF status ON users
  FOR EACH ROW
  WHEN (NEW.status = 'deleted' AND OLD.status IS DISTINCT FROM 'deleted')
  EXECUTE FUNCTION revoke_deleted_account_gift_address_refs();

COMMENT ON FUNCTION revoke_deleted_account_gift_address_refs() IS
  'Revokes opaque private gift-address references for every order involving a deleted account, including delivered orders, without rewriting delivery or payment evidence.';
