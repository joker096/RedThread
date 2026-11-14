-- Encrypted recipient address payloads are isolated from gift order/event tables.
-- Application code must insert/update the order's opaque reference and this row in
-- one transaction after recipient consent and address verification.
CREATE TABLE IF NOT EXISTS gift_address_vault_entries (
  vault_ref UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL UNIQUE REFERENCES gift_delivery_orders(id) ON DELETE CASCADE,
  recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  key_version VARCHAR(32) NOT NULL CHECK (key_version ~ '^[A-Za-z0-9._-]{1,32}$'),
  nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
  auth_tag BYTEA NOT NULL CHECK (octet_length(auth_tag) = 16),
  ciphertext BYTEA NOT NULL CHECK (octet_length(ciphertext) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS gift_address_vault_recipient_idx
  ON gift_address_vault_entries (recipient_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS gift_address_vault_access_events (
  id BIGSERIAL PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES gift_delivery_orders(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'read_for_recipient', 'read_for_fulfilment', 'updated', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS gift_address_vault_access_order_time_idx
  ON gift_address_vault_access_events (order_id, created_at DESC);

CREATE OR REPLACE FUNCTION enforce_gift_address_vault_entry_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $vault_scope$
DECLARE
  order_row RECORD;
BEGIN
  SELECT recipient_id, status, recipient_consent_at, recipient_consent_version,
         address_vault_ref, address_verified_at
  INTO order_row
  FROM gift_delivery_orders
  WHERE id = NEW.order_id
  FOR UPDATE;

  IF NOT FOUND
     OR order_row.recipient_id <> NEW.recipient_user_id
     OR order_row.status NOT IN ('address_verified', 'fulfilment_authorized', 'dispatched', 'delivered', 'delivery_failed')
     OR order_row.recipient_consent_at IS NULL
     OR order_row.recipient_consent_version IS NULL
     OR order_row.address_verified_at IS NULL
     OR order_row.address_vault_ref IS DISTINCT FROM NEW.vault_ref::text THEN
    RAISE EXCEPTION 'gift address vault entry is not authorized for this order'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$vault_scope$;

DROP TRIGGER IF EXISTS gift_address_vault_entry_scope_guard ON gift_address_vault_entries;
CREATE TRIGGER gift_address_vault_entry_scope_guard
  BEFORE INSERT OR UPDATE ON gift_address_vault_entries
  FOR EACH ROW EXECUTE FUNCTION enforce_gift_address_vault_entry_scope();

CREATE OR REPLACE FUNCTION purge_deleted_account_gift_address_vault()
RETURNS trigger
LANGUAGE plpgsql
AS $vault_erasure$
BEGIN
  IF NEW.status = 'deleted' AND OLD.status IS DISTINCT FROM 'deleted' THEN
    DELETE FROM gift_address_vault_entries v
    USING gift_delivery_orders o
    WHERE v.order_id = o.id
      AND (o.sender_id = NEW.id OR o.recipient_id = NEW.id);
  END IF;
  RETURN NEW;
END;
$vault_erasure$;

DROP TRIGGER IF EXISTS users_purge_gift_address_vault ON users;
CREATE TRIGGER users_purge_gift_address_vault
  AFTER UPDATE OF status ON users
  FOR EACH ROW
  WHEN (NEW.status = 'deleted' AND OLD.status IS DISTINCT FROM 'deleted')
  EXECUTE FUNCTION purge_deleted_account_gift_address_vault();

COMMENT ON TABLE gift_address_vault_entries IS
  'Recipient address payload encrypted with AES-256-GCM by the application; never store plaintext addresses in order or event tables. Key material is external to PostgreSQL.';
COMMENT ON TABLE gift_address_vault_access_events IS
  'PII-free audit trail for access to encrypted gift address records. Never add address, phone, coordinates, or delivery instructions.';
