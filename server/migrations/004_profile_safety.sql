ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS photo_urls TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS occupation VARCHAR(120) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS education VARCHAR(120) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS languages TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE profiles
  ADD CONSTRAINT profiles_photo_urls_limit CHECK (cardinality(photo_urls) <= 6),
  ADD CONSTRAINT profiles_languages_limit CHECK (cardinality(languages) <= 10);

CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS user_blocks_blocked_idx ON user_blocks (blocked_id, blocker_id);
