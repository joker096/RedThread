CREATE TABLE IF NOT EXISTS date_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  proposed_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  venue_name VARCHAR(120) NOT NULL CHECK (LENGTH(BTRIM(venue_name)) BETWEEN 2 AND 120),
  is_public_venue BOOLEAN NOT NULL DEFAULT FALSE CHECK (is_public_venue = TRUE),
  starts_at TIMESTAMPTZ NOT NULL,
  time_zone VARCHAR(80) NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'confirmed', 'declined', 'cancelled', 'expired')),
  confirmed_by_a_at TIMESTAMPTZ,
  confirmed_by_b_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (status = 'confirmed' AND confirmed_by_a_at IS NOT NULL AND confirmed_by_b_at IS NOT NULL)
    OR status = 'proposed'
    OR (status IN ('declined', 'cancelled', 'expired') AND confirmed_by_a_at IS NULL AND confirmed_by_b_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS date_plans_one_open_per_match_idx
  ON date_plans (match_id)
  WHERE status IN ('proposed', 'confirmed');

CREATE INDEX IF NOT EXISTS date_plans_match_history_idx
  ON date_plans (match_id, created_at DESC);

CREATE TABLE IF NOT EXISTS date_plan_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date_plan_id UUID NOT NULL REFERENCES date_plans(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('proposed', 'updated', 'confirmed', 'declined', 'cancelled')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS date_plan_events_plan_created_idx
  ON date_plan_events (date_plan_id, created_at DESC);
