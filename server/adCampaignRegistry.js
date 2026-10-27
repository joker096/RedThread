const VALID_STATUSES = new Set(['pending', 'approved', 'paused', 'rejected', 'expired']);
const ALLOWED_CATEGORIES = new Set([
  'restaurant', 'cafe', 'date_experience', 'flowers', 'gift',
  'fashion', 'beauty', 'travel', 'general_local'
]);

export function evaluateAdCampaignEligibility(campaign, { now = Date.now() } = {}) {
  if (!campaign || typeof campaign !== 'object') return deny('campaign_unknown');
  if (!Number.isFinite(now)) return deny('invalid_validation_clock');
  if (typeof campaign.id !== 'string' || campaign.id.length === 0) return deny('campaign_unknown');
  if (!VALID_STATUSES.has(campaign.status)) return deny('campaign_status_invalid');
  if (campaign.status !== 'approved') return deny(campaign.status === 'expired' ? 'campaign_expired' : 'campaign_not_approved');
  if (campaign.advertiserVerified !== true) return deny('advertiser_not_verified');
  if (campaign.creativeApproved !== true || typeof campaign.creativeVersion !== 'string' || !campaign.creativeVersion.trim()) return deny('creative_not_approved');
  if (typeof campaign.category !== 'string' || !ALLOWED_CATEGORIES.has(campaign.category)) return deny('campaign_category_not_allowed');
  const startsAt = typeof campaign.startsAt === 'string' ? Date.parse(campaign.startsAt) : NaN;
  const endsAt = typeof campaign.endsAt === 'string' ? Date.parse(campaign.endsAt) : NaN;
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) return deny('campaign_window_invalid');
  if (startsAt > now) return deny('campaign_not_started');
  if (endsAt <= now) return deny('campaign_expired');
  return { eligible: true, reason: 'approved_campaign_active', campaignId: campaign.id, category: campaign.category, creativeVersion: campaign.creativeVersion };
}

function deny(reason) {
  return { eligible: false, reason };
}
