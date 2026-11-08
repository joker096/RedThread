DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'partner_service_inquiry_provider_message_status_valid'
      AND conrelid = 'partner_service_inquiries'::regclass
  ) THEN
    ALTER TABLE partner_service_inquiries
      ADD CONSTRAINT partner_service_inquiry_provider_message_status_valid
      CHECK (provider_message_id IS NULL OR delivery_status IN ('sent', 'reconciliation_required'));
  END IF;
END $$;
