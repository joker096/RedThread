// Shared by the ad-event endpoint and PostgreSQL regression tests.
export const AD_EVENT_FREQUENCY_COUNTS_SQL = `WITH recent_events AS (
         SELECT
           event_type,
           created_at,
           COUNT(*) OVER (PARTITION BY event_type)::int AS event_count,
           ROW_NUMBER() OVER (PARTITION BY event_type ORDER BY created_at ASC, event_id ASC) AS event_position
         FROM ad_events
         WHERE user_id = $1 AND campaign_id = $2
           AND created_at >= NOW() - INTERVAL '24 hours'
           AND created_at <= NOW()
       )
       SELECT
         COUNT(*) FILTER (WHERE event_type = 'impression')::int AS impressions,
         COUNT(*) FILTER (WHERE event_type = 'click')::int AS clicks,
         COALESCE(
           MAX(GREATEST(1, CEIL(EXTRACT(EPOCH FROM (created_at + INTERVAL '24 hours' - NOW()))))::int)
             FILTER (
               WHERE event_type = 'impression'
                 AND event_position = GREATEST(event_count - 3 + 1, 1)
             ),
           1
         ) AS impression_retry_after_seconds,
         COALESCE(
           MAX(GREATEST(1, CEIL(EXTRACT(EPOCH FROM (created_at + INTERVAL '24 hours' - NOW()))))::int)
             FILTER (
               WHERE event_type = 'click'
                 AND event_position = GREATEST(event_count - 5 + 1, 1)
             ),
           1
         ) AS click_retry_after_seconds
       FROM recent_events`;
