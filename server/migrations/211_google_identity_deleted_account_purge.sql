-- Account erasure is a soft tombstone transition, so ON DELETE CASCADE alone
-- does not remove external authentication identifiers. Purge Google subject links
-- in the same transaction when an account is marked deleted.
CREATE OR REPLACE FUNCTION purge_google_identity_on_account_deletion()
RETURNS trigger
LANGUAGE plpgsql
AS $google_identity_purge$
BEGIN
  IF OLD.status IS DISTINCT FROM 'deleted' AND NEW.status = 'deleted' THEN
    DELETE FROM user_auth_identities WHERE user_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$google_identity_purge$;

DROP TRIGGER IF EXISTS users_purge_google_identity_on_deletion ON users;
CREATE TRIGGER users_purge_google_identity_on_deletion
  AFTER UPDATE OF status ON users
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM 'deleted' AND NEW.status = 'deleted')
  EXECUTE FUNCTION purge_google_identity_on_account_deletion();

COMMENT ON FUNCTION purge_google_identity_on_account_deletion() IS
  'Removes Google provider-subject identifiers during soft account erasure; the account tombstone remains, but the deleted person can later register again with the same Google identity.';
