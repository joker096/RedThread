-- Keep PostgreSQL writes aligned with the server-side campaign registry.
-- NOT VALID preserves existing rows for audit while enforcing the rule on new/updated rows.
-- The application remains fail-closed for any legacy row outside this allowlist.
ALTER TABLE ad_campaigns
  ADD CONSTRAINT ad_campaigns_category_allowlist
  CHECK (category IN (
    'restaurant', 'cafe', 'date_experience', 'flowers', 'gift',
    'fashion', 'beauty', 'travel', 'general_local'
  )) NOT VALID;

COMMENT ON CONSTRAINT ad_campaigns_category_allowlist ON ad_campaigns IS
  'Restricts new and updated campaigns to the categories approved by server/adCampaignRegistry.js; legacy rows require separate audit before validation.';
