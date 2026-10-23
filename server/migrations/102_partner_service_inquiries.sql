CREATE TABLE IF NOT EXISTS partner_service_inquiries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES partner_service_applications(id) ON DELETE RESTRICT,
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_key UUID NOT NULL,
  requester_name VARCHAR(80) NOT NULL,
  requester_email VARCHAR(254) NOT NULL,
  service_date DATE,
  request_note VARCHAR(2000) NOT NULL,
  contact_consent_at TIMESTAMPTZ NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'failed'
    CHECK (delivery_status IN ('sending', 'sent', 'failed')),
  delivery_attempts SMALLINT NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  delivery_error VARCHAR(100) NOT NULL DEFAULT '',
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (requested_by, request_key),
  CHECK (LENGTH(BTRIM(request_note)) BETWEEN 20 AND 2000)
);

CREATE INDEX IF NOT EXISTS partner_service_inquiries_delivery_idx
  ON partner_service_inquiries (delivery_status, created_at DESC);

CREATE INDEX IF NOT EXISTS partner_service_inquiries_application_idx
  ON partner_service_inquiries (application_id, created_at DESC);
