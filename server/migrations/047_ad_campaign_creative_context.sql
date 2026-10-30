-- Creative purpose is independent of the broad ad category. In particular,
-- "fashion" and "beauty" must not be used to disguise bridal creatives.
-- Existing campaigns remain NULL until a moderator explicitly classifies them;
-- the serving/eligibility layer must reject NULL classifications.
ALTER TABLE ad_campaigns
  ADD COLUMN IF NOT EXISTS creative_context TEXT;

ALTER TABLE ad_campaigns
  ADD CONSTRAINT ad_campaigns_creative_context_check
  CHECK (creative_context IS NULL OR creative_context IN ('general', 'bridal'))
  NOT VALID;

COMMENT ON COLUMN ad_campaigns.creative_context IS
  'Moderator-owned purpose classification independent of category; NULL legacy rows are not eligible for serving.';
