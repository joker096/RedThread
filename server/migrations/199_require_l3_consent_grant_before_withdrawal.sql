-- A consent row represents a grant when it is first created. Withdrawal
-- must be a separate audited state transition so the withdrawal/purge guard
-- and the matching append-only event cannot be bypassed by an INSERT.
CREATE OR REPLACE FUNCTION guard_identity_l3_consent_insert()
RETURNS trigger LANGUAGE plpgsql AS $l3_consent_insert_guard$
BEGIN
  IF NEW.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'identity L3 consent must be created as an active grant; withdrawal requires the audited transition'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$l3_consent_insert_guard$;

CREATE TRIGGER identity_l3_consents_insert_guard
  BEFORE INSERT ON identity_l3_consents
  FOR EACH ROW
  EXECUTE FUNCTION guard_identity_l3_consent_insert();

COMMENT ON FUNCTION guard_identity_l3_consent_insert() IS
  'Requires every new current-consent row to begin as an active grant; a withdrawn state can only be reached through the guarded update that records withdrawal and enqueues media purge.';
