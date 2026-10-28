-- A consent timestamp alone must not make a vault pointer available during an earlier order state.
-- Address pointers are permitted only after address verification has been recorded.
-- Keep legacy rows auditable; PostgreSQL still enforces this for future inserts and updates.
ALTER TABLE gift_delivery_orders
  ADD CONSTRAINT gift_orders_address_vault_requires_verified_stage
  CHECK (
    address_vault_ref IS NULL OR (
      status IN (
        'address_verified', 'fulfilment_authorized', 'dispatched',
        'delivered', 'delivery_failed'
      )
      AND recipient_consent_at IS NOT NULL
      AND recipient_consent_version IS NOT NULL
      AND recipient_consent_version > 0
      AND address_verified_at IS NOT NULL
    )
  ) NOT VALID;

COMMENT ON CONSTRAINT gift_orders_address_vault_requires_verified_stage ON gift_delivery_orders IS
  'An address-vault pointer may exist only after recipient consent and address verification, in a permitted post-verification order state.';
