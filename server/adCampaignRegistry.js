const VALID_STATUSES = new Set(['pending', 'approved', 'paused', 'rejected', 'expired']);
const ALLOWED_CATEGORIES = new Set([
  'restaurant', 'cafe', 'date_experience', 'flowers', 'gift',
  'fashion', 'beauty', 'travel', 'general_local'
]);

const COUNTRY_ALIASES = new Map([
  ['GE', 'GE'], ['GEORGIA', 'GE'], ['ГРУЗИЯ', 'GE'], ['SAKARTVELO', 'GE'],
  ['US', 'US'], ['USA', 'US'], ['UNITED STATES', 'US'], ['США', 'US'],
  ['GB', 'GB'], ['UK', 'GB'], ['UNITED KINGDOM', 'GB'], ['ВЕЛИКОБРИТАНИЯ', 'GB'],
  ['RU', 'RU'], ['RUSSIA', 'RU'], ['РОССИЯ', 'RU'],
  ['AM', 'AM'], ['ARMENIA', 'AM'], ['АРМЕНИЯ', 'AM'],
  ['AZ', 'AZ'], ['AZERBAIJAN', 'AZ'], ['АЗЕРБАЙДЖАН', 'AZ'],
  ['TR', 'TR'], ['TURKEY', 'TR'], ['TÜRKIYE', 'TR'], ['ТУРЦИЯ', 'TR'],
  ['DE', 'DE'], ['GERMANY', 'DE'], ['ГЕРМАНИЯ', 'DE'],
  ['FR', 'FR'], ['FRANCE', 'FR'], ['ФРАНЦИЯ', 'FR'],
  ['IT', 'IT'], ['ITALY', 'IT'], ['ИТАЛИЯ', 'IT'],
  ['ES', 'ES'], ['SPAIN', 'ES'], ['ИСПАНИЯ', 'ES'],
  ['CA', 'CA'], ['CANADA', 'CA'], ['КАНАДА', 'CA'],
  ['AU', 'AU'], ['AUSTRALIA', 'AU'], ['АВСТРАЛИЯ', 'AU'],
  ['IN', 'IN'], ['INDIA', 'IN'], ['ИНДИЯ', 'IN'],
  ['JP', 'JP'], ['JAPAN', 'JP'], ['ЯПОНИЯ', 'JP'],
  ['CN', 'CN'], ['CHINA', 'CN'], ['КИТАЙ', 'CN'],
  ['UA', 'UA'], ['UKRAINE', 'UA'], ['УКРАИНА', 'UA']
]);

export function resolveProfileCountryCode(country) {
  if (typeof country !== 'string') return null;
  const normalized = country.trim().toLocaleUpperCase('en-US');
  if (!normalized) return null;
  return COUNTRY_ALIASES.get(normalized) || null;
}

export function isCampaignCountryAllowed(allowedCountryCodes, countryCode) {
  if (!Array.isArray(allowedCountryCodes) || allowedCountryCodes.length === 0) return false;
  if (typeof countryCode !== 'string' || !/^[A-Z]{2}$/.test(countryCode)) return false;
  const normalizedAllowlist = allowedCountryCodes.filter(code => typeof code === 'string').map(code => code.trim().toUpperCase());
  return normalizedAllowlist.includes(countryCode);
}

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
