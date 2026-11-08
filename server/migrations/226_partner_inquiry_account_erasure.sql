-- Account erasure may redact the request payload, but never rewrite consent
-- evidence, request identity, or an accepted provider message ID.
CREATE OR REPLACE FUNCTION prevent_partner_service_inquiry_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $partner_inquiry_evidence$
BEGIN
  IF NEW.application_id IS DISTINCT FROM OLD.application_id
     OR NEW.match_id IS DISTINCT FROM OLD.match_id
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.request_key IS DISTINCT FROM OLD.request_key
     OR NEW.contact_consent_at IS DISTINCT FROM OLD.contact_consent_at
     OR NEW.contact_consent_version IS DISTINCT FROM OLD.contact_consent_version
     OR (OLD.provider_message_id IS NOT NULL AND NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id) THEN
    RAISE EXCEPTION 'partner service inquiry identity, consent and provider acceptance evidence is immutable';
  END IF;

  IF NEW.requester_name IS DISTINCT FROM OLD.requester_name
     OR NEW.requester_email IS DISTINCT FROM OLD.requester_email
     OR NEW.service_date IS DISTINCT FROM OLD.service_date
     OR NEW.request_note IS DISTINCT FROM OLD.request_note THEN
    IF current_setting('app.partner_inquiry_account_erasure', true) IS DISTINCT FROM 'on'
       OR NEW.requester_name IS DISTINCT FROM 'Удалённый пользователь'
       OR NEW.requester_email IS DISTINCT FROM ('deleted+' || OLD.requested_by::text || '@deleted.invalid')
       OR NEW.service_date IS NOT NULL
       OR NEW.request_note IS DISTINCT FROM '[запрос удалён пользователем]' THEN
      RAISE EXCEPTION 'partner service inquiry request payload is immutable outside account erasure';
    END IF;
  END IF;
  RETURN NEW;
END;
$partner_inquiry_evidence$;

COMMENT ON FUNCTION prevent_partner_service_inquiry_evidence_mutation() IS
  'Freezes request identity and consent/provider evidence; permits only a guarded account-erasure redaction of requester PII.';
