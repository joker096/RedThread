CREATE TABLE IF NOT EXISTS profile_discovery_views (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_on DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, profile_id, viewed_on),
  CHECK (user_id <> profile_id)
);

CREATE INDEX IF NOT EXISTS profile_discovery_views_user_day_idx
  ON profile_discovery_views (user_id, viewed_on, created_at DESC);

CREATE INDEX IF NOT EXISTS profile_discovery_views_profile_day_idx
  ON profile_discovery_views (profile_id, viewed_on);
