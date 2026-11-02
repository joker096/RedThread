-- An opaque address-vault pointer is sensitive even when the address itself is stored elsewhere.
-- Do not allow the order to reference it until the recipient's explicit, versioned consent is persisted.
-- NOT VALID allows a pre-deployment audit of any legacy rows while enforcing future writes/updates.
ALTER TABLE gift_delivery_orders
  ADD CONSTRAINT gift_orders_address_vault_requires_recipient_consent
  CHECK (
    address_vault_ref IS NULL OR (
      recipient_consent_at IS NOT NULL
      AND recipient_consent_version IS NOT NULL
      AND recipient_consent_version > 0
    )
  ) NOT VALID;

COMMENT ON CONSTRAINT gift_orders_address_vault_requires_recipient_consent ON gift_delivery_orders IS
  'An order cannot reference recipient address-vault data until explicit versioned recipient consent is persisted.';
