-- A creative's approval is tied to the exact version, category and purpose
-- that moderators reviewed. Any change invalidates the previous approval.
CREATE OR REPLACE FUNCTION reset_ad_campaign_approval_on_creative_change()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.creative_context IS DISTINCT FROM OLD.creative_context
     OR NEW.creative_version IS DISTINCT FROM OLD.creative_version
     OR NEW.category IS DISTINCT FROM OLD.category THEN
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
DROP TRIGGER IF EXISTS ad_campaign_creative_reapproval ON ad_campaigns;
CREATE TRIGGER ad_campaign_creative_reapproval
BEFORE UPDATE OF creative_context, creative_version, category ON ad_campaigns
FOR EACH ROW
EXECUTE FUNCTION reset_ad_campaign_approval_on_creative_change();

DROP FUNCTION IF EXISTS reset_ad_campaign_approval_on_creative_context_change();
