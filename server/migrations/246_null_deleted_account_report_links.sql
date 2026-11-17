-- Preserve immutable user-report snapshots while removing live account links
-- from reports when either participant is soft-deleted.
CREATE OR REPLACE FUNCTION null_deleted_account_user_report_links()
RETURNS trigger
LANGUAGE plpgsql
AS $report_account_erasure$
BEGIN
  IF NEW.status = 'deleted' AND OLD.status IS DISTINCT FROM 'deleted' THEN
    UPDATE user_reports
       SET reporter_id = CASE WHEN reporter_id = NEW.id THEN NULL ELSE reporter_id END,
           reported_user_id = CASE WHEN reported_user_id = NEW.id THEN NULL ELSE reported_user_id END
     WHERE reporter_id = NEW.id OR reported_user_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$report_account_erasure$;

DROP TRIGGER IF EXISTS users_null_deleted_account_report_links ON users;
CREATE TRIGGER users_null_deleted_account_report_links
  AFTER UPDATE OF status ON users
  FOR EACH ROW
  WHEN (NEW.status = 'deleted' AND OLD.status IS DISTINCT FROM 'deleted')
  EXECUTE FUNCTION null_deleted_account_user_report_links();

COMMENT ON FUNCTION null_deleted_account_user_report_links() IS
  'Nulls live reporter/target FKs during soft account erasure while retaining immutable reporter_ref/reported_user_ref snapshots and report source evidence.';
