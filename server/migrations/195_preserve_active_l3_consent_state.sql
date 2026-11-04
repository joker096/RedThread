-- The current consent row is the access-control source of truth. Removing it
-- from an active account without the withdrawal workflow would silently revoke
-- authorization without transitioning submissions or creating purge jobs.
CREATE OR REPLACE FUNCTION prevent_identity_l3_consent_delete_while_active()
RETURNS trigger LANGUAGE plpgsql AS $l3_consent_delete_guard$
BEGIN
  IF pg_trigger_depth() <= 1
     AND EXISTS (
       SELECT 1 FROM users
       WHERE id = OLD.user_id
         AND status <> 'deleted'
     ) THEN
    RAISE EXCEPTION 'active identity L3 consent must be withdrawn through the consent workflow, not deleted'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$l3_consent_delete_guard$;

CREATE TRIGGER identity_l3_consents_active_delete_guard
  BEFORE DELETE ON identity_l3_consents
  FOR EACH ROW
  EXECUTE FUNCTION prevent_identity_l3_consent_delete_while_active();

CREATE TRIGGER identity_l3_consents_no_truncate
  BEFORE TRUNCATE ON identity_l3_consents
  FOR EACH STATEMENT
  EXECUTE FUNCTION prevent_evidence_truncate();

COMMENT ON FUNCTION prevent_identity_l3_consent_delete_while_active() IS
  'Prevents deleting the current consent state for an active account; users must withdraw consent through the audited transition that revokes approvals and enqueues media purge. Account-erasure cleanup and nested FK cascades remain permitted.';
