-- A prior approval is not sufficient after the applicant withdraws consent.
-- Keep the database access predicate fail-closed even if a workflow row is stale.
CREATE OR REPLACE FUNCTION identity_l3_has_active_approval(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE AS $l3_active$
DECLARE
  current_status TEXT;
  current_expiry TIMESTAMPTZ;
BEGIN
  SELECT decision.status, decision.expires_at
    INTO current_status, current_expiry
  FROM identity_l3_current_decision(p_user_id) AS decision;

  RETURN COALESCE(
    current_status = 'approved'
    AND current_expiry > statement_timestamp()
    AND EXISTS (
      SELECT 1
      FROM identity_l3_consents consent
      WHERE consent.user_id = p_user_id
        AND consent.consent_version = 1
        AND consent.withdrawn_at IS NULL
    ),
    FALSE
  );
END;
$l3_active$;

COMMENT ON FUNCTION identity_l3_has_active_approval(UUID) IS
  'L3 access requires the latest unexpired approval and current explicit version-1 video-processing consent.';
