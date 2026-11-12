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
      AND pg_get_constraintdef(oid) ILIKE '%status <> ALL%'
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
    -- The authenticated deletion service first blocks/suspends every in-flight
    -- order and clears its address pointer. A direct SQL tombstone must fail
    -- closed rather than bypassing that payment/safety workflow.
    IF EXISTS (
      SELECT 1
      FROM gift_delivery_orders
      WHERE (sender_id = NEW.id OR recipient_id = NEW.id)
        AND address_vault_ref IS NOT NULL
        AND status IN ('address_verified', 'fulfilment_authorized', 'dispatched', 'delivery_failed')
    ) THEN
      RAISE EXCEPTION 'gift order safety workflow must revoke in-flight address access before account tombstoning'
        USING ERRCODE = '23514';
    END IF;

    -- Once fulfilment is complete, revoke the address pointer but preserve
    -- immutable delivery, consent, dispatch, and payment evidence.
    UPDATE gift_delivery_orders
    SET address_vault_ref = NULL,
        updated_at = statement_timestamp()
    WHERE (sender_id = NEW.id OR recipient_id = NEW.id)
      AND address_vault_ref IS NOT NULL
      AND status = 'delivered';
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
  'Revokes completed-delivery address pointers for deleted accounts while preserving delivery/payment evidence; refuses direct tombstoning if an in-flight order still needs the authenticated safety/payment workflow.';
