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
      p_user_id,
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
    ELSIF TG_TABLE_NAME = 'identity_l3_submissions' AND NEW.status = 'approved' THEN
      -- A fresh approval is a safety boundary: any plan under the previous
      -- approval must be proposed and mutually confirmed again.
      should_cancel := TRUE;
    ELSIF TG_TABLE_NAME = 'identity_l3_consents' AND NEW.withdrawn_at IS NOT NULL THEN
      should_cancel := TRUE;
    ELSE
      should_cancel := NOT identity_l3_has_active_approval(affected_user_id);
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
