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

CREATE OR REPLACE FUNCTION cancel_date_plans_when_match_closes()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'active' AND NEW.status <> 'active' THEN
    UPDATE date_plans
    SET status = 'cancelled', confirmed_by_a_at = NULL, confirmed_by_b_at = NULL, updated_at = NOW()
    WHERE match_id = NEW.id AND status IN ('proposed', 'confirmed');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS matches_cancel_date_plans_on_close ON matches;
CREATE TRIGGER matches_cancel_date_plans_on_close
AFTER UPDATE OF status ON matches
FOR EACH ROW EXECUTE FUNCTION cancel_date_plans_when_match_closes();

CREATE OR REPLACE FUNCTION cancel_date_plans_when_users_block()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  WITH cancelled AS (
    UPDATE date_plans dp
    SET status = 'cancelled', confirmed_by_a_at = NULL, confirmed_by_b_at = NULL, updated_at = NOW()
    FROM matches m
    WHERE dp.match_id = m.id
      AND m.status = 'active'
      AND ((m.user_a_id = NEW.blocker_id AND m.user_b_id = NEW.blocked_id)
        OR (m.user_a_id = NEW.blocked_id AND m.user_b_id = NEW.blocker_id))
      AND dp.status IN ('proposed', 'confirmed')
    RETURNING dp.id
  )
  INSERT INTO date_plan_events (date_plan_id, actor_id, event_type)
  SELECT id, NEW.blocker_id, 'cancelled' FROM cancelled;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_blocks_cancel_date_plans ON user_blocks;
CREATE TRIGGER user_blocks_cancel_date_plans
AFTER INSERT ON user_blocks
FOR EACH ROW EXECUTE FUNCTION cancel_date_plans_when_users_block();
