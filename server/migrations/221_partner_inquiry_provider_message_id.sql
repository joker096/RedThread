ALTER TABLE partner_service_inquiries
  ADD COLUMN IF NOT EXISTS provider_message_id VARCHAR(255);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'partner_service_inquiry_provider_message_id_valid'
      AND conrelid = 'partner_service_inquiries'::regclass
  ) THEN
    ALTER TABLE partner_service_inquiries
      ADD CONSTRAINT partner_service_inquiry_provider_message_id_valid
      CHECK (provider_message_id IS NULL OR LENGTH(BTRIM(provider_message_id)) BETWEEN 1 AND 255);
  END IF;
END $$;
