-- Enforce the audit trail's no-recipient-secrets rule at the database boundary.
-- Key-name checks are defense in depth; callers must still avoid embedding PII in arbitrary values.
CREATE OR REPLACE FUNCTION gift_event_metadata_has_forbidden_key(value_json jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $function$
DECLARE
  entry record;
  normalized_key text;
BEGIN
  IF jsonb_typeof(value_json) = 'object' THEN
    FOR entry IN SELECT key, value FROM jsonb_each(value_json) LOOP
      normalized_key := lower(regexp_replace(entry.key, '[^a-zA-Z0-9]', '', 'g'));
      IF normalized_key = ANY (ARRAY[
        'address', 'street', 'streetaddress', 'streetaddress1', 'streetaddress2',
        'addressline', 'addressline1', 'addressline2', 'shippingaddress', 'deliveryaddress',
        'recipientaddress', 'recipientfullname', 'recipientname', 'addressvaultref',
        'phone', 'phonenumber', 'recipientphone', 'recipientphonenumber',
        'contactphone', 'deliveryphone',
        'email', 'emailaddress', 'recipientemail', 'contactemail', 'deliveryemail',
        'contactdetails', 'recipientcontact',
        'coordinates', 'gpscoordinates', 'geolocation', 'latitude', 'longitude', 'lat', 'lon', 'lng',
        'postalcode', 'postcode', 'zipcode',
        'deliveryinstructions', 'chattext', 'chatmessage', 'messagebody',
        'recipientsecret', 'password', 'authorizationheader', 'accesstoken'
      ]) THEN
        RETURN TRUE;
      END IF;
      IF gift_event_metadata_has_forbidden_key(entry.value) THEN
        RETURN TRUE;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(value_json) = 'array' THEN
    FOR entry IN SELECT value FROM jsonb_array_elements(value_json) LOOP
      IF gift_event_metadata_has_forbidden_key(entry.value) THEN
        RETURN TRUE;
      END IF;
    END LOOP;
  END IF;
  RETURN FALSE;
END;
$function$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM gift_delivery_order_events
    WHERE gift_event_metadata_has_forbidden_key(metadata)
  ) THEN
    RAISE EXCEPTION
      'gift event metadata contains forbidden recipient-secret keys; clean up records before migration 026';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'gift_order_events_metadata_no_sensitive_keys'
      AND conrelid = 'gift_delivery_order_events'::regclass
  ) THEN
    ALTER TABLE gift_delivery_order_events
      ADD CONSTRAINT gift_order_events_metadata_no_sensitive_keys
      CHECK (NOT gift_event_metadata_has_forbidden_key(metadata));
  END IF;
END $$;

COMMENT ON FUNCTION gift_event_metadata_has_forbidden_key(jsonb) IS
  'Recursive defense-in-depth check preventing common recipient PII/secret key names in gift event metadata; does not detect PII embedded in arbitrary string values.';
