-- Provider verification documents contain private external objects, but this
-- repository has no durable purge queue/worker/completion workflow for them.
-- Keep the metadata row as the durable pointer until that workflow exists.
-- This deliberately fails closed: application code cannot erase the pointer
-- and then lose the ability to locate the external object for physical purge.
CREATE OR REPLACE FUNCTION prevent_unverified_provider_document_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $provider_document_purge_guard$
BEGIN
  RAISE EXCEPTION
    'provider verification document deletion requires a verified physical purge workflow'
    USING ERRCODE = '55000',
          CONSTRAINT = 'provider_verification_document_purge_required';
END;
$provider_document_purge_guard$;

DROP TRIGGER IF EXISTS provider_verification_document_purge_guard
  ON provider_verification_documents;
CREATE TRIGGER provider_verification_document_purge_guard
  BEFORE DELETE ON provider_verification_documents
  FOR EACH ROW
  EXECUTE FUNCTION prevent_unverified_provider_document_delete();

COMMENT ON FUNCTION prevent_unverified_provider_document_delete() IS
  'Fail-closed guard: provider verification documents cannot be deleted until a durable physical purge obligation and completion workflow exists.';
