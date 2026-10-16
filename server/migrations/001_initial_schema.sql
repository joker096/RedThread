CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'provider', 'moderator', 'admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'suspended', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name VARCHAR(80) NOT NULL,
  birth_date DATE,
  gender TEXT NOT NULL CHECK (gender IN ('female', 'male')),
  country VARCHAR(100) NOT NULL,
  city VARCHAR(120) NOT NULL,
  bio VARCHAR(2000) NOT NULL DEFAULT '',
  relationship_intent TEXT NOT NULL DEFAULT 'marriage_family'
    CHECK (relationship_intent IN ('marriage_family', 'serious_relationship')),
  is_visible BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS profiles_location_idx ON profiles (LOWER(country), LOWER(city));
CREATE INDEX IF NOT EXISTS profiles_discovery_idx ON profiles (gender, is_visible, relationship_intent);

CREATE TABLE IF NOT EXISTS profile_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  min_age SMALLINT NOT NULL DEFAULT 18 CHECK (min_age >= 18 AND min_age <= 100),
  max_age SMALLINT NOT NULL DEFAULT 99 CHECK (max_age >= min_age AND max_age <= 120),
  country VARCHAR(100),
  city VARCHAR(120),
  min_compatibility SMALLINT NOT NULL DEFAULT 70 CHECK (min_compatibility BETWEEN 0 AND 100),
  only_verified BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS likes (
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sender_id, target_id),
  CHECK (sender_id <> target_id)
);

CREATE INDEX IF NOT EXISTS likes_target_idx ON likes (target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (user_a_id < user_b_id),
  UNIQUE (user_a_id, user_b_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body VARCHAR(4000) NOT NULL CHECK (LENGTH(BTRIM(body)) BETWEEN 1 AND 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS messages_match_time_idx ON messages (match_id, created_at DESC);

CREATE TABLE IF NOT EXISTS partner_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('legal', 'dress_rental', 'photography', 'videography', 'host', 'venue', 'beauty', 'other')),
  business_name VARCHAR(160) NOT NULL,
  country VARCHAR(100) NOT NULL,
  city VARCHAR(120) NOT NULL,
  service_jurisdictions TEXT[] NOT NULL DEFAULT '{}',
  verification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending', 'in_review', 'verified', 'rejected', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS partner_providers_location_idx ON partner_providers (LOWER(country), LOWER(city), category);

-- Only private object-storage keys and review metadata belong here, never document bytes.
CREATE TABLE IF NOT EXISTS provider_verification_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES partner_providers(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('identity', 'legal_education', 'professional_license', 'registry_extract', 'business_registration', 'other')),
  private_storage_key TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected', 'expired')),
  expires_at DATE,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS service_booking_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE RESTRICT,
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider_id UUID NOT NULL REFERENCES partner_providers(id) ON DELETE RESTRICT,
  service_country VARCHAR(100) NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'accepted', 'declined', 'cancelled', 'completed')),
  request_note VARCHAR(2000) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS booking_provider_status_idx ON service_booking_requests (provider_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS user_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('spam', 'fake_profile', 'harassment', 'safety', 'other')),
  details VARCHAR(2000) NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (reporter_id <> reported_user_id)
);

CREATE INDEX IF NOT EXISTS user_reports_queue_idx ON user_reports (status, created_at);
