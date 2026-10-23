CREATE TABLE IF NOT EXISTS provider_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_name VARCHAR(120) NOT NULL,
  business_name VARCHAR(160) NOT NULL,
  email TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN (
    'legal', 'dress_rental', 'photography', 'videography', 'host', 'venue', 'beauty', 'cafe', 'other'
  )),
  country VARCHAR(100) NOT NULL,
  city VARCHAR(120) NOT NULL,
  service_description VARCHAR(1000) NOT NULL,
  website_url TEXT,
  public_registry_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_review', 'approved', 'rejected')),
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  decision_note VARCHAR(500) NOT NULL DEFAULT '',
  consented_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_applications_open_email_category_idx
  ON provider_applications (LOWER(email), category)
  WHERE status IN ('pending', 'in_review');

CREATE INDEX IF NOT EXISTS provider_applications_review_queue_idx
  ON provider_applications (status, created_at);
