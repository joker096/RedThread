-- Creative purpose is independent of the broad ad category. In particular,
-- "fashion" and "beauty" must not be used to disguise bridal creatives.
-- Existing campaigns remain NULL until a moderator explicitly classifies them;
-- the serving/eligibility layer must reject NULL classifications.
ALTER TABLE ad_campaigns
  ADD COLUMN IF NOT EXISTS creative_context TEXT;

ALTER TABLE ad_campaigns
  ADD CONSTRAINT ad_campaigns_creative_context_check
  CHECK (creative_context IS NOT NULL AND creative_context IN ('general', 'bridal'))
  NOT VALID;

COMMENT ON COLUMN ad_campaigns.creative_context IS
  'Moderator-owned purpose classification independent of category; NULL legacy rows are not eligible for serving.';

-- Changing a creative's purpose invalidates its previous creative review.
-- The campaign must be reviewed and approved again after reclassification.
CREATE OR REPLACE FUNCTION reset_ad_campaign_approval_on_creative_context_change()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.creative_context IS DISTINCT FROM OLD.creative_context THEN
    NEW.creative_approved := FALSE;
    IF NEW.status = 'approved' THEN
      NEW.status := 'pending';
    END IF;
    NEW.updated_at := NOW();
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS ad_campaign_creative_context_reapproval ON ad_campaigns;
CREATE TRIGGER ad_campaign_creative_context_reapproval
BEFORE UPDATE OF creative_context ON ad_campaigns
FOR EACH ROW
EXECUTE FUNCTION reset_ad_campaign_approval_on_creative_context_change();
