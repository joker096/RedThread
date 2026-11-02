-- The applicant-facing notice changed to disclose the 30-day pending-review
-- retention deadline. Only explicit consent to the current notice version may
-- authorize L3 access; older approvals fail closed until the applicant re-consents.
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
        AND consent.consent_version = 2
        AND consent.withdrawn_at IS NULL
    ),
    FALSE
  );
END;
$l3_active$;

COMMENT ON FUNCTION identity_l3_has_active_approval(UUID) IS
  'L3 access requires the latest unexpired approval and current explicit version-2 video-processing consent.';
