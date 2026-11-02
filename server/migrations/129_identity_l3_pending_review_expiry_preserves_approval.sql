-- Expiring an undecided re-verification is a retention event, not a new
-- identity decision. It must not supersede a still-valid prior L3 approval.
-- Approved expiries always have approved_at; pending-review expiries do not.
CREATE OR REPLACE FUNCTION identity_l3_current_decision(p_user_id UUID)
RETURNS TABLE(status TEXT, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql VOLATILE AS $l3_decision$
BEGIN
  RETURN QUERY
  SELECT s.status, s.expires_at
  FROM identity_l3_submissions s
  WHERE s.user_id = p_user_id
    AND s.status IN ('approved', 'rejected', 'revoked', 'expired')
    AND (s.status <> 'expired' OR s.approved_at IS NOT NULL)
  ORDER BY COALESCE(s.approved_at, s.reviewed_at) DESC NULLS LAST,
           COALESCE(s.revoked_at, s.approved_at, s.reviewed_at) DESC NULLS LAST,
           s.created_at DESC, s.id DESC
  LIMIT 1
  FOR SHARE;
END;
$l3_decision$;

COMMENT ON FUNCTION identity_l3_current_decision(UUID) IS
  'Returns the latest terminal identity decision. Pending-review retention expiry is excluded because it is not an identity decision and must not supersede a prior approval.';
