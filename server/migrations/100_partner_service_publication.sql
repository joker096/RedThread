ALTER TABLE partner_service_applications
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS published_by UUID REFERENCES users(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'partner_service_publication_requires_approval'
      AND conrelid = 'partner_service_applications'::regclass
  ) THEN
    ALTER TABLE partner_service_applications
      ADD CONSTRAINT partner_service_publication_requires_approval
      CHECK (
        (published_at IS NULL AND published_by IS NULL)
        OR (status = 'approved' AND published_at IS NOT NULL AND published_by IS NOT NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS partner_service_applications_published_idx
  ON partner_service_applications (published_at DESC, business_name)
  WHERE status = 'approved' AND published_at IS NOT NULL;
