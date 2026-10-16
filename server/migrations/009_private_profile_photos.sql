CREATE TABLE IF NOT EXISTS photo_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png')),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 8388608),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 20000),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 20000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS photo_assets_user_created_idx ON photo_assets (user_id, created_at DESC);
COMMENT ON TABLE photo_assets IS 'Metadata for private profile photos. Image bytes live outside the database and are served only after authorization.';
