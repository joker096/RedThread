-- Trusted identity evidence and supplier/region price gates for gift request creation.
-- This migration stores only verification status metadata, never identity documents or raw provider payloads.
CREATE TABLE IF NOT EXISTS user_identity_verifications (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  verification_level SMALLINT NOT NULL CHECK (verification_level BETWEEN 1 AND 3),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'revoked')),
  provider_key VARCHAR(80) NOT NULL CHECK (provider_key ~ '^[a-z0-9_-]{2,80}$'),
  verified_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status <> 'approved' OR (verified_at IS NOT NULL AND expires_at IS NOT NULL AND expires_at > verified_at)),
  CHECK (status <> 'approved' OR verification_level <> 3 OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS user_identity_verifications_current_idx
  ON user_identity_verifications (status, expires_at)
  WHERE status = 'approved';

COMMENT ON TABLE user_identity_verifications IS
  'Server-trusted verification state only. Never store ID images, selfies, biometrics, document numbers, or raw provider payloads here. User-facing APIs must not write this table.';

CREATE TABLE IF NOT EXISTS gift_suppliers (
  supplier_key VARCHAR(120) PRIMARY KEY CHECK (supplier_key ~ '^[A-Za-z0-9._:-]{2,120}$'),
  display_name VARCHAR(160) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'suspended', 'retired')),
  privacy_reviewed_at TIMESTAMPTZ,
  contract_reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status <> 'verified' OR (privacy_reviewed_at IS NOT NULL AND contract_reviewed_at IS NOT NULL))
);

COMMENT ON TABLE gift_suppliers IS
  'Server-reviewed supplier registry, separate from delivery-carrier partners. Catalog entries without a verified supplier are never eligible for gift requests.';

ALTER TABLE gift_delivery_partner_coverage
  ADD COLUMN IF NOT EXISTS delivery_fee_minor_units BIGINT,
  ADD COLUMN IF NOT EXISTS delivery_fee_currency CHAR(3);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'gift_coverage_delivery_fee_pair'
      AND conrelid = 'gift_delivery_partner_coverage'::regclass
  ) THEN
    ALTER TABLE gift_delivery_partner_coverage
      ADD CONSTRAINT gift_coverage_delivery_fee_pair
      CHECK (
        (delivery_fee_minor_units IS NULL AND delivery_fee_currency IS NULL)
        OR (
          delivery_fee_minor_units IS NOT NULL
          AND delivery_fee_currency IS NOT NULL
          AND delivery_fee_minor_units >= 0
          AND delivery_fee_currency ~ '^[A-Z]{3}
      );
  END IF;
END $$;

ALTER TABLE gift_delivery_orders
  ADD COLUMN IF NOT EXISTS item_price_minor_units BIGINT,
  ADD COLUMN IF NOT EXISTS delivery_fee_minor_units BIGINT,
  ADD COLUMN IF NOT EXISTS delivery_fee_currency CHAR(3);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'gift_orders_price_snapshot_consistency'
      AND conrelid = 'gift_delivery_orders'::regclass
  ) THEN
    ALTER TABLE gift_delivery_orders
      ADD CONSTRAINT gift_orders_price_snapshot_consistency
      CHECK (
        (item_price_minor_units IS NULL AND delivery_fee_minor_units IS NULL AND delivery_fee_currency IS NULL)
        OR (
          item_price_minor_units IS NOT NULL
          AND item_price_minor_units > 0
          AND delivery_fee_minor_units IS NOT NULL
          AND delivery_fee_minor_units >= 0
          AND delivery_fee_currency IS NOT NULL
          AND delivery_fee_currency = currency
          AND total_minor_units = item_price_minor_units + delivery_fee_minor_units
        )
      );
  END IF;
END $$;

COMMENT ON COLUMN gift_delivery_orders.item_price_minor_units IS
  'Price snapshot for the selected catalog item at request creation; NULL only on legacy rows created before migration 035.';
COMMENT ON COLUMN gift_delivery_orders.delivery_fee_minor_units IS
  'Verified delivery fee snapshot from the selected partner coverage record. This is not payment authorization.';
COMMENT ON COLUMN gift_delivery_partner_coverage.delivery_fee_minor_units IS
  'Reviewed local delivery fee; NULL means coverage must fail closed until a price is configured.';

        )
      );
  END IF;
END $$;

ALTER TABLE gift_delivery_orders
  ADD COLUMN IF NOT EXISTS item_price_minor_units BIGINT,
  ADD COLUMN IF NOT EXISTS delivery_fee_minor_units BIGINT,
  ADD COLUMN IF NOT EXISTS delivery_fee_currency CHAR(3);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'gift_orders_price_snapshot_consistency'
      AND conrelid = 'gift_delivery_orders'::regclass
  ) THEN
    ALTER TABLE gift_delivery_orders
      ADD CONSTRAINT gift_orders_price_snapshot_consistency
      CHECK (
        (item_price_minor_units IS NULL AND delivery_fee_minor_units IS NULL AND delivery_fee_currency IS NULL)
        OR (
          item_price_minor_units > 0
          AND delivery_fee_minor_units >= 0
          AND delivery_fee_currency = currency
          AND total_minor_units = item_price_minor_units + delivery_fee_minor_units
        )
      );
  END IF;
END $$;

COMMENT ON COLUMN gift_delivery_orders.item_price_minor_units IS
  'Price snapshot for the selected catalog item at request creation; NULL only on legacy rows created before migration 035.';
COMMENT ON COLUMN gift_delivery_orders.delivery_fee_minor_units IS
  'Verified delivery fee snapshot from the selected partner coverage record. This is not payment authorization.';
COMMENT ON COLUMN gift_delivery_partner_coverage.delivery_fee_minor_units IS
  'Reviewed local delivery fee; NULL means coverage must fail closed until a price is configured.';
