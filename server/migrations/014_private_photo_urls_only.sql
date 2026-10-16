-- Remove legacy/external photo URLs that bypassed upload sanitization and review.
-- Keep only private photo assets owned by the profile owner.
UPDATE profiles AS p
SET photo_urls = COALESCE((
  SELECT array_agg(x.photo_url ORDER BY x.ordinality)
  FROM unnest(COALESCE(p.photo_urls, ARRAY[]::text[])) WITH ORDINALITY AS x(photo_url, ordinality)
  JOIN photo_assets AS a
    ON x.photo_url = '/api/photos/' || a.id::text
   AND a.user_id = p.user_id
), ARRAY[]::text[])
WHERE EXISTS (
  SELECT 1
  FROM unnest(COALESCE(p.photo_urls, ARRAY[]::text[])) AS existing(photo_url)
  LEFT JOIN photo_assets AS a
    ON existing.photo_url = '/api/photos/' || a.id::text
   AND a.user_id = p.user_id
  WHERE a.id IS NULL
);
