-- Consent history is an audit trail: application roles must not rewrite or directly erase recorded choices.
-- Allow FK-driven cleanup when a user is deleted, while rejecting direct DELETE statements.
CREATE OR REPLACE FUNCTION reject_ad_consent_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'ad_consent_history is append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS ad_consent_history_append_only ON ad_consent_history;
CREATE TRIGGER ad_consent_history_append_only
  BEFORE UPDATE OR DELETE ON ad_consent_history
  FOR EACH ROW
  EXECUTE FUNCTION reject_ad_consent_history_mutation();

COMMENT ON FUNCTION reject_ad_consent_history_mutation() IS
  'Prevents direct mutation of advertising consent history; allows cascading cleanup on user deletion.';
