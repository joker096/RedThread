-- Google GIS challenges are single-use and short-lived. Only a hash of the nonce/ticket
-- is stored; raw values are returned once to the browser and never persisted.
CREATE TABLE IF NOT EXISTS google_auth_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nonce_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS google_auth_challenges_expiry_idx
  ON google_auth_challenges (expires_at);

CREATE TABLE IF NOT EXISTS user_auth_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google')),
  provider_subject TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_subject),
  UNIQUE (provider, user_id)
);

CREATE INDEX IF NOT EXISTS user_auth_identities_user_idx
  ON user_auth_identities (user_id);

CREATE TABLE IF NOT EXISTS google_registration_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_hash TEXT NOT NULL UNIQUE,
  provider_subject TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS google_registration_tickets_expiry_idx
  ON google_registration_tickets (expires_at);
