ALTER TABLE photo_assets
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (review_status IN ('pending', 'approved', 'rejected'));
CREATE INDEX IF NOT EXISTS photo_assets_review_queue_idx ON photo_assets (review_status, created_at ASC);
