ALTER TABLE partner_service_inquiries
  ADD COLUMN IF NOT EXISTS contact_consent_version VARCHAR(32);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'partner_service_inquiry_contact_consent_version_valid'
      AND conrelid = 'partner_service_inquiries'::regclass
  ) THEN
    ALTER TABLE partner_service_inquiries
      ADD CONSTRAINT partner_service_inquiry_contact_consent_version_valid
      CHECK (contact_consent_version IS NULL OR contact_consent_version = 'partner-inquiry-v1');
  END IF;
END $$;
