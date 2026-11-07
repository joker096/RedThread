-- The weekly free-tier quota counts a user's matches from either side.
-- These indexes keep the rolling-window count bounded as the match table grows.
CREATE INDEX matches_user_a_created_at_idx
  ON matches (user_a_id, created_at DESC);

CREATE INDEX matches_user_b_created_at_idx
  ON matches (user_b_id, created_at DESC);
