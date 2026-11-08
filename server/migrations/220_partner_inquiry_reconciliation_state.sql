ALTER TABLE partner_service_inquiries
  DROP CONSTRAINT IF EXISTS partner_service_inquiries_delivery_status_check;

ALTER TABLE partner_service_inquiries
  ADD CONSTRAINT partner_service_inquiries_delivery_status_check
  CHECK (delivery_status IN ('pending', 'sending', 'sent', 'failed', 'reconciliation_required'));

-- Rows already in sending at migration time have an unknown outcome. They must
-- not be retried or reconciled while a provider call is active; this migration
-- should be applied during a normal application rollout with workers drained.
UPDATE partner_service_inquiries
SET delivery_status = 'reconciliation_required',
    delivery_error = 'pre_migration_outcome_requires_reconciliation',
    updated_at = NOW()
WHERE delivery_status = 'sending';