-- Preserve immutable consent history for active accounts, but honor account deletion.
-- The deletion endpoint first marks the account deleted and then purges its consent
-- snapshots in the same transaction. Cascading FK cleanup remains permitted.
CREATE OR REPLACE FUNCTION reject_ad_consent_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM users
      WHERE id = OLD.user_id
        AND status = 'deleted'
    ) THEN
      RETURN OLD;
    END IF;
  END IF;

  RAISE EXCEPTION 'ad_consent_history is append-only for active accounts'
    USING ERRCODE = '55000';
END;
$$;

COMMENT ON FUNCTION reject_ad_consent_history_mutation() IS
  'Prevents mutation of consent history for active accounts; permits FK cascade and explicit purge after account deletion.';
