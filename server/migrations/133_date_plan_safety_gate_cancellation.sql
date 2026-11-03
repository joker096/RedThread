-- A confirmed date plan is valid only while both participants remain eligible
-- for interaction. Revoke active plans when account status or identity gates change.
-- A later re-verification must never silently revive an old mutual confirmation.

CREATE OR REPLACE FUNCTION cancel_date_plans_for_safety_change(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql AS $date_plan_safety$
DECLARE
  plan_row RECORD;
  other_user_id UUID;
BEGIN
  FOR plan_row IN
    UPDATE date_plans dp
       SET status = 'cancelled',
           confirmed_by_a_at = NULL,
           confirmed_by_b_at = NULL,
           updated_at = statement_timestamp()
      FROM matches m
     WHERE dp.match_id = m.id
       AND (m.user_a_id = p_user_id OR m.user_b_id = p_user_id)
       AND dp.status IN ('proposed', 'confirmed')
    RETURNING dp.id, dp.match_id
  LOOP
    INSERT INTO date_plan_events (date_plan_id, actor_id, event_type, details)
    VALUES (
      plan_row.id,
      NULL,
      'cancelled',
      jsonb_build_object('reason', 'participant_safety_eligibility_lost')
    );

    SELECT CASE
             WHEN m.user_a_id = p_user_id THEN m.user_b_id
             ELSE m.user_a_id
           END
      INTO other_user_id
      FROM matches m
     WHERE m.id = plan_row.match_id;

    INSERT INTO user_notifications (user_id, type, metadata, dedupe_key)
    SELECT u.id,
           'date_plan_cancelled',
           jsonb_build_object('matchId', plan_row.match_id, 'datePlanId', plan_row.id),
           'date-plan-safety-' || plan_row.id::text
      FROM users u
     WHERE u.id = other_user_id
       AND u.status = 'active'
    ON CONFLICT (user_id, dedupe_key) DO NOTHING;
  END LOOP;
END;
$date_plan_safety$;

CREATE OR REPLACE FUNCTION cancel_date_plans_after_account_deactivation()
RETURNS TRIGGER
LANGUAGE plpgsql AS $date_plan_account$
BEGIN
  IF OLD.status = 'active' AND NEW.status <> 'active' THEN
    PERFORM cancel_date_plans_for_safety_change(NEW.id);
  END IF;
  RETURN NEW;
END;
$date_plan_account$;

DROP TRIGGER IF EXISTS users_cancel_date_plans_on_deactivation ON users;
CREATE TRIGGER users_cancel_date_plans_on_deactivation
AFTER UPDATE OF status ON users
FOR EACH ROW
WHEN (OLD.status = 'active' AND NEW.status <> 'active')
EXECUTE FUNCTION cancel_date_plans_after_account_deactivation();

CREATE OR REPLACE FUNCTION cancel_date_plans_after_l2_change()
RETURNS TRIGGER
LANGUAGE plpgsql AS $date_plan_l2$
DECLARE
  affected_user_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    affected_user_id := OLD.user_id;
  ELSE
    affected_user_id := NEW.user_id;
  END IF;

  IF EXISTS (
       SELECT 1 FROM profiles p
        WHERE p.user_id = affected_user_id AND p.gender = 'male'
     )
     AND NOT EXISTS (
       SELECT 1
         FROM identity_verifications iv
        WHERE iv.user_id = affected_user_id
          AND iv.provider = 'didit'
          AND iv.status = 'verified'
          AND iv.provider_environment = 'live'
          AND iv.provider_status = 'Approved'
          AND iv.provider_session_id IS NOT NULL
     ) THEN
    PERFORM cancel_date_plans_for_safety_change(affected_user_id);
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$date_plan_l2$;

DROP TRIGGER IF EXISTS identity_verifications_cancel_date_plans_on_gate_loss ON identity_verifications;
CREATE TRIGGER identity_verifications_cancel_date_plans_on_gate_loss
AFTER INSERT OR UPDATE OR DELETE ON identity_verifications
FOR EACH ROW EXECUTE FUNCTION cancel_date_plans_after_l2_change();

CREATE OR REPLACE FUNCTION cancel_date_plans_after_l3_change()
RETURNS TRIGGER
LANGUAGE plpgsql AS $date_plan_l3$
DECLARE
  affected_user_id UUID;
  should_cancel BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    affected_user_id := OLD.user_id;
  ELSE
    affected_user_id := NEW.user_id;
  END IF;

  -- L3 is a mandatory gate only for male participants. Do not let unrelated
  -- identity metadata on female accounts cancel an otherwise valid date plan.
  IF EXISTS (
    SELECT 1 FROM profiles p
     WHERE p.user_id = affected_user_id AND p.gender = 'male'
  ) THEN
    IF TG_OP = 'DELETE' THEN
      should_cancel := NOT identity_l3_has_active_approval(affected_user_id);
    ELSIF TG_TABLE_NAME = 'identity_l3_submissions' THEN
      IF TG_OP = 'UPDATE'
         AND NEW.status = 'approved'
         AND OLD.status IS DISTINCT FROM 'approved' THEN
        -- Only a transition into a fresh approval is a safety boundary.
        -- Non-decision updates (for example, retention metadata) must not
        -- invalidate a still-current approval or an already confirmed plan.
        should_cancel := TRUE;
      ELSE
        should_cancel := NOT identity_l3_has_active_approval(affected_user_id);
      END IF;
    ELSIF TG_TABLE_NAME = 'identity_l3_consents' THEN
      IF NEW.withdrawn_at IS NOT NULL THEN
        should_cancel := TRUE;
      ELSE
        should_cancel := NOT identity_l3_has_active_approval(affected_user_id);
      END IF;
    END IF;
  END IF;

  IF should_cancel THEN
    PERFORM cancel_date_plans_for_safety_change(affected_user_id);
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$date_plan_l3$;

DROP TRIGGER IF EXISTS identity_l3_submissions_cancel_date_plans_on_gate_loss ON identity_l3_submissions;
CREATE TRIGGER identity_l3_submissions_cancel_date_plans_on_gate_loss
AFTER INSERT OR UPDATE OR DELETE ON identity_l3_submissions
FOR EACH ROW EXECUTE FUNCTION cancel_date_plans_after_l3_change();

DROP TRIGGER IF EXISTS identity_l3_consents_cancel_date_plans_on_withdrawal ON identity_l3_consents;
CREATE TRIGGER identity_l3_consents_cancel_date_plans_on_withdrawal
AFTER INSERT OR UPDATE OR DELETE ON identity_l3_consents
FOR EACH ROW EXECUTE FUNCTION cancel_date_plans_after_l3_change();

COMMENT ON FUNCTION cancel_date_plans_for_safety_change(UUID) IS
  'Cancels active mutual date plans and sends a generic notification when a participant loses account or identity eligibility; old confirmations never revive after re-verification.';

-- Match closure and either-direction blocking also invalidate consent. Keep this
-- path notification-aware so both participants (or only the blocked participant)
-- receive a generic alert without exposing who initiated the safety action.
CREATE OR REPLACE FUNCTION cancel_date_plans_for_match(
  p_match_id UUID,
  p_actor_id UUID,
  p_reason TEXT,
  p_notify_user_ids UUID[]
)
RETURNS VOID
LANGUAGE plpgsql AS $date_plan_match_safety$
DECLARE
  match_row RECORD;
  plan_row RECORD;
  event_actor_id UUID;
BEGIN
  SELECT user_a_id, user_b_id
    INTO match_row
    FROM matches
   WHERE id = p_match_id;
  IF NOT FOUND THEN RETURN; END IF;

  event_actor_id := CASE
    WHEN p_actor_id = match_row.user_a_id OR p_actor_id = match_row.user_b_id THEN p_actor_id
    ELSE NULL
  END;

  FOR plan_row IN
    UPDATE date_plans
       SET status = 'cancelled',
           confirmed_by_a_at = NULL,
           confirmed_by_b_at = NULL,
           updated_at = statement_timestamp()
     WHERE match_id = p_match_id
       AND status IN ('proposed', 'confirmed')
    RETURNING id
  LOOP
    INSERT INTO date_plan_events (date_plan_id, actor_id, event_type, details)
    VALUES (
      plan_row.id,
      event_actor_id,
      'cancelled',
      jsonb_build_object('reason', p_reason)
    );

    INSERT INTO user_notifications (user_id, type, metadata, dedupe_key)
    SELECT u.id,
           'date_plan_cancelled',
           jsonb_build_object('matchId', p_match_id, 'datePlanId', plan_row.id),
           'date-plan-safety-' || plan_row.id::text
      FROM users u
     WHERE u.id = ANY(COALESCE(p_notify_user_ids, ARRAY[]::UUID[]))
       AND u.status = 'active'
    ON CONFLICT (user_id, dedupe_key) DO NOTHING;
  END LOOP;
END;
$date_plan_match_safety$;

CREATE OR REPLACE FUNCTION cancel_date_plans_when_match_closes()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'active' AND NEW.status <> 'active' THEN
    PERFORM cancel_date_plans_for_match(
      NEW.id, NULL, 'match_closed', ARRAY[NEW.user_a_id, NEW.user_b_id]
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION cancel_date_plans_when_users_block()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  affected_match_id UUID;
BEGIN
  SELECT id
    INTO affected_match_id
    FROM matches
   WHERE status = 'active'
     AND ((user_a_id = NEW.blocker_id AND user_b_id = NEW.blocked_id)
       OR (user_a_id = NEW.blocked_id AND user_b_id = NEW.blocker_id))
   LIMIT 1;

  IF affected_match_id IS NOT NULL THEN
    PERFORM cancel_date_plans_for_match(
      affected_match_id, NEW.blocker_id, 'participant_blocked', ARRAY[NEW.blocked_id]
    );
  END IF;
  RETURN NEW;
END;
$$;
