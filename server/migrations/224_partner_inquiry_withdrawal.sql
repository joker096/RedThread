ALTER TABLE partner_service_inquiries
  DROP CONSTRAINT IF EXISTS partner_service_inquiries_delivery_status_check;

ALTER TABLE partner_service_inquiries
  ADD CONSTRAINT partner_service_inquiries_delivery_status_check
  CHECK (delivery_status IN ('pending', 'sending', 'sent', 'failed', 'reconciliation_required', 'cancelled'));

ALTER TABLE partner_service_inquiries
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

ALTER TABLE partner_service_inquiries
  ADD CONSTRAINT partner_service_inquiry_cancelled_at_valid
  CHECK ((delivery_status = 'cancelled') = (cancelled_at IS NOT NULL));
