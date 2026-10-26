-- Speed up retrieving the latest persisted discovery action for undo.
CREATE INDEX IF NOT EXISTS likes_sender_created_at_idx
  ON likes (sender_id, created_at DESC);

CREATE INDEX IF NOT EXISTS profile_passes_passer_created_at_idx
  ON profile_passes (passer_id, created_at DESC);
