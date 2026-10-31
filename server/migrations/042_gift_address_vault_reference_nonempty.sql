-- An opaque vault reference must be a usable reference, not an empty or whitespace-only value.
-- Keep legacy rows auditable while enforcing future inserts and updates.
ALTER TABLE gift_delivery_orders
  ADD CONSTRAINT gift_orders_address_vault_reference_nonempty
  CHECK (
    address_vault_ref IS NULL OR btrim(address_vault_ref) <> ''
  ) NOT VALID;

COMMENT ON CONSTRAINT gift_orders_address_vault_reference_nonempty ON gift_delivery_orders IS
  'An address-vault reference must be NULL or a non-empty, non-whitespace opaque reference.';
