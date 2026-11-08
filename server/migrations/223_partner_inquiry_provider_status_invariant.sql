UPDATE partner_service_inquiries
SET delivery_status = 'reconciliation_required',
    delivery_error = 'provider_acceptance_recorded_before_status_invariant',
    updated_at = NOW()
WHERE provider_message_id IS NOT NULL
  AND delivery_status = 'failed';

DO $
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
