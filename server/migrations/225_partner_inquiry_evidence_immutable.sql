-- Freeze the original request and consent snapshot. Delivery and reconciliation
-- may change state, but must never rewrite what the requester agreed to share.
CREATE OR REPLACE FUNCTION prevent_partner_service_inquiry_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $partner_inquiry_evidence$
BEGIN
  IF NEW.application_id IS DISTINCT FROM OLD.application_id
     OR NEW.match_id IS DISTINCT FROM OLD.match_id
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.request_key IS DISTINCT FROM OLD.request_key
     OR NEW.requester_name IS DISTINCT FROM OLD.requester_name
     OR NEW.requester_email IS DISTINCT FROM OLD.requester_email
     OR NEW.service_date IS DISTINCT FROM OLD.service_date
     OR NEW.request_note IS DISTINCT FROM OLD.request_note
     OR NEW.contact_consent_at IS DISTINCT FROM OLD.contact_consent_at
     OR NEW.contact_consent_version IS DISTINCT FROM OLD.contact_consent_version
     OR (OLD.provider_message_id IS NOT NULL AND NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id) THEN
    RAISE EXCEPTION 'partner service inquiry request, consent and provider acceptance evidence is immutable';
  END IF;
  RETURN NEW;
END;
$partner_inquiry_evidence$;

DROP TRIGGER IF EXISTS partner_service_inquiry_evidence_immutable ON partner_service_inquiries;
CREATE TRIGGER partner_service_inquiry_evidence_immutable
  BEFORE UPDATE OF application_id, match_id, requested_by, request_key,
    requester_name, requester_email, service_date, request_note,
    contact_consent_at, contact_consent_version, provider_message_id
  ON partner_service_inquiries
  FOR EACH ROW
  EXECUTE FUNCTION prevent_partner_service_inquiry_evidence_mutation();

COMMENT ON FUNCTION prevent_partner_service_inquiry_evidence_mutation() IS
  'Prevents rewriting a partner inquiry request, its consent snapshot, or an accepted provider message ID; delivery state remains mutable through guarded transitions.';
