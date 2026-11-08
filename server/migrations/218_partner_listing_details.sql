ALTER TABLE partner_service_applications
  ADD COLUMN IF NOT EXISTS price_from NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS price_currency TEXT NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS service_languages TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS availability_note VARCHAR(500) NOT NULL DEFAULT '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'partner_service_price_is_valid'
      AND conrelid = 'partner_service_applications'::regclass
  ) THEN
    ALTER TABLE partner_service_applications
      ADD CONSTRAINT partner_service_price_is_valid
      CHECK (price_from IS NULL OR price_from >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'partner_service_price_currency_is_valid'
      AND conrelid = 'partner_service_applications'::regclass
  ) THEN
    ALTER TABLE partner_service_applications
      ADD CONSTRAINT partner_service_price_currency_is_valid
      CHECK (price_currency IN ('USD', 'GEL', 'EUR', 'RUB', 'KZT', 'AMD'));
  END IF;
END $$;
