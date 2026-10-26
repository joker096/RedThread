-- Gift receiving preferences and order state only. Never store recipient street address or phone in these tables.
-- Address details must live in a dedicated encrypted vault; orders store only an opaque vault reference after recipient acceptance.
CREATE TABLE IF NOT EXISTS gift_receiving_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  requests_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gift_delivery_partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_key VARCHAR(100) NOT NULL UNIQUE,
  display_name VARCHAR(160) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'suspended', 'retired')),
  privacy_reviewed_at TIMESTAMPTZ,
  contract_reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status <> 'verified' OR (privacy_reviewed_at IS NOT NULL AND contract_reviewed_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS gift_delivery_partner_coverage (
  partner_id UUID NOT NULL REFERENCES gift_delivery_partners(id) ON DELETE CASCADE,
  country_code CHAR(2) NOT NULL CHECK (country_code = UPPER(country_code)),
  city_key VARCHAR(120) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at TIMESTAMPTZ,
  PRIMARY KEY (partner_id, country_code, city_key),
  CHECK (active = FALSE OR verified_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS gift_catalog_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku VARCHAR(100) NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('flowers', 'chocolate', 'confectionery', 'book', 'approved_gift')),
  display_name VARCHAR(160) NOT NULL,
  description VARCHAR(1000) NOT NULL DEFAULT '',
  price_minor_units BIGINT NOT NULL CHECK (price_minor_units > 0),
  currency CHAR(3) NOT NULL CHECK (currency = UPPER(currency)),
  supplier_key VARCHAR(120) NOT NULL,
  approved BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (active = FALSE OR approved = TRUE)
);

CREATE TABLE IF NOT EXISTS gift_delivery_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_reference VARCHAR(48) NOT NULL UNIQUE
    DEFAULT ('gift_' || replace(gen_random_uuid()::text, '-', '')),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE RESTRICT,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  catalog_item_id UUID REFERENCES gift_catalog_items(id) ON DELETE SET NULL,
  product_name_snapshot VARCHAR(160) NOT NULL,
  product_category TEXT NOT NULL CHECK (product_category IN ('flowers', 'chocolate', 'confectionery', 'book', 'approved_gift')),
  total_minor_units BIGINT NOT NULL CHECK (total_minor_units > 0),
  currency CHAR(3) NOT NULL CHECK (currency = UPPER(currency)),
  delivery_partner_id UUID REFERENCES gift_delivery_partners(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'awaiting_recipient_consent'
    CHECK (status IN (
      'awaiting_recipient_consent', 'recipient_accepted', 'address_verified',
      'fulfilment_authorized', 'dispatched', 'delivered', 'declined', 'expired',
      'cancelled', 'blocked', 'reported', 'delivery_failed', 'refund_pending', 'refunded'
    )),
  payment_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (payment_status IN ('not_started', 'authorization_pending', 'authorized', 'captured', 'voided', 'refund_pending', 'refunded', 'failed')),
  recipient_consent_at TIMESTAMPTZ,
  recipient_consent_version SMALLINT,
  address_vault_ref TEXT,
  address_verified_at TIMESTAMPTZ,
  fulfilment_authorized_at TIMESTAMPTZ,
  dispatched_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  estimated_delivery_start TIMESTAMPTZ,
  estimated_delivery_end TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '72 hours'),
  idempotency_key VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (sender_id <> recipient_id),
  CHECK (estimated_delivery_end IS NULL OR estimated_delivery_start IS NULL OR estimated_delivery_end >= estimated_delivery_start),
  CHECK (status NOT IN ('recipient_accepted', 'address_verified', 'fulfilment_authorized', 'dispatched', 'delivered') OR recipient_consent_at IS NOT NULL),
  CHECK (status NOT IN ('address_verified', 'fulfilment_authorized', 'dispatched', 'delivered') OR (address_vault_ref IS NOT NULL AND address_verified_at IS NOT NULL)),
  CHECK (status NOT IN ('fulfilment_authorized', 'dispatched', 'delivered') OR (fulfilment_authorized_at IS NOT NULL AND payment_status IN ('authorized', 'captured'))),
  CHECK (status <> 'dispatched' OR dispatched_at IS NOT NULL),
  CHECK (status <> 'delivered' OR delivered_at IS NOT NULL),
  UNIQUE (sender_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS gift_orders_recipient_status_idx
  ON gift_delivery_orders (recipient_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS gift_orders_sender_status_idx
  ON gift_delivery_orders (sender_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS gift_orders_match_created_idx
  ON gift_delivery_orders (match_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS gift_orders_one_pending_per_pair_idx
  ON gift_delivery_orders (match_id, sender_id, recipient_id)
  WHERE status = 'awaiting_recipient_consent';

CREATE TABLE IF NOT EXISTS gift_delivery_order_events (
  id BIGSERIAL PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES gift_delivery_orders(id) ON DELETE RESTRICT,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('sender', 'recipient', 'system', 'moderator', 'delivery_partner', 'payment_service')),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'request_created', 'accepted', 'declined', 'expired', 'address_verified',
    'fulfilment_authorized', 'dispatched', 'delivered', 'delivery_failed',
    'cancelled', 'blocked', 'reported', 'payment_authorized', 'payment_captured',
    'payment_voided', 'refund_requested', 'refunded', 'safety_hold'
  )),
  from_status TEXT,
  to_status TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS gift_order_events_order_time_idx
  ON gift_delivery_order_events (order_id, created_at DESC);

COMMENT ON TABLE gift_receiving_preferences IS
  'Gift-request preference is independent of ad consent and defaults off.';
COMMENT ON TABLE gift_delivery_orders IS
  'Order state and opaque address-vault reference only. Never store recipient street address, phone, email, coordinates, or delivery instructions here.';
COMMENT ON COLUMN gift_delivery_orders.address_vault_ref IS
  'Opaque pointer to a separately encrypted address vault; populate only after explicit recipient consent and address verification.';
COMMENT ON TABLE gift_delivery_order_events IS
  'Audit trail for gift order transitions. Metadata must not contain address, phone, email, coordinates, chat text, or other recipient secrets.';
