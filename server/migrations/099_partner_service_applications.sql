CREATE TABLE IF NOT EXISTS partner_service_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL CHECK (category IN ('cafe', 'photography', 'videography', 'venue', 'beauty', 'legal', 'transport', 'other')),
  business_name VARCHAR(160) NOT NULL,
  contact_name VARCHAR(120) NOT NULL,
  contact_email VARCHAR(254) NOT NULL,
  country VARCHAR(100) NOT NULL,
  city VARCHAR(120) NOT NULL,
  website TEXT NOT NULL DEFAULT '',
  service_description VARCHAR(2000) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_review', 'approved', 'rejected')),
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_note VARCHAR(1000) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS partner_service_applications_queue_idx
  ON partner_service_applications (status, created_at ASC);
