export const VALID_AD_CAMPAIGN_STATUSES = Object.freeze(['pending', 'approved', 'paused', 'rejected', 'expired']);
const VALID_STATUSES = new Set(VALID_AD_CAMPAIGN_STATUSES);
export const ALLOWED_AD_CAMPAIGN_CATEGORIES = Object.freeze([
  'restaurant', 'cafe', 'date_experience', 'flowers', 'gift',
  'fashion', 'beauty', 'travel', 'general_local'
]);
const ALLOWED_CATEGORIES = new Set(ALLOWED_AD_CAMPAIGN_CATEGORIES);
const SUPPORTED_COUNTRY_CODES = new Set(COUNTRY_ALIASES.values());

const COUNTRY_ALIASES = new Map([
  ['GE', 'GE'], ['GEORGIA', 'GE'], ['ГРУЗИЯ', 'GE'], ['SAKARTVELO', 'GE'],
  ['US', 'US'], ['USA', 'US'], ['UNITED STATES', 'US'], ['США', 'US'],
  ['GB', 'GB'], ['UK', 'GB'], ['UNITED KINGDOM', 'GB'], ['ВЕЛИКОБРИТАНИЯ', 'GB'],
  ['RU', 'RU'], ['RUSSIA', 'RU'], ['РОССИЯ', 'RU'],
  ['AM', 'AM'], ['ARMENIA', 'AM'], ['АРМЕНИЯ', 'AM'],
  ['AZ', 'AZ'], ['AZERBAIJAN', 'AZ'], ['АЗЕРБАЙДЖАН', 'AZ'],
  ['TR', 'TR'], ['TURKEY', 'TR'], ['TÜRKIYE', 'TR'], ['TÜRKİYE', 'TR'], ['ТУРЦИЯ', 'TR'],
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
  const normalized = country.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleUpperCase('en-US').normalize('NFC');
  if (!normalized) return null;
  return COUNTRY_ALIASES.get(normalized) || null;
}

export function isCampaignCountryAllowed(allowedCountryCodes, countryCode) {
  if (!Array.isArray(allowedCountryCodes) || allowedCountryCodes.length === 0) return false;
  if (typeof countryCode !== 'string' || !SUPPORTED_COUNTRY_CODES.has(countryCode)) return false;
  const normalizedAllowlist = allowedCountryCodes
    .filter(code => typeof code === 'string')
    .map(code => code.trim().toUpperCase())
    .filter(code => SUPPORTED_COUNTRY_CODES.has(code));
  return normalizedAllowlist.includes(countryCode);
}

export function evaluateAdCampaignEligibility(campaign, { now = Date.now() } = {}) {
  if (!campaign || typeof campaign !== 'object') return deny('campaign_unknown');
  if (!Number.isFinite(now)) return deny('invalid_validation_clock');
  if (typeof campaign.id !== 'string' || campaign.id.trim().length === 0) return deny('campaign_unknown');
  if (!VALID_STATUSES.has(campaign.status)) return deny('campaign_status_invalid');
  if (campaign.status !== 'approved') return deny(campaign.status === 'expired' ? 'campaign_expired' : 'campaign_not_approved');
  if (campaign.active !== true) return deny('campaign_not_active');
  if (campaign.advertiserVerified !== true) return deny('advertiser_not_verified');
  if (campaign.creativeApproved !== true || typeof campaign.creativeVersion !== 'string' || !campaign.creativeVersion.trim()) return deny('creative_not_approved');
  if (typeof campaign.category !== 'string' || !ALLOWED_CATEGORIES.has(campaign.category)) return deny('campaign_category_not_allowed');
  const startsAt = isValidTimestamp(campaign.startsAt) ? Date.parse(campaign.startsAt) : NaN;
  const endsAt = isValidTimestamp(campaign.endsAt) ? Date.parse(campaign.endsAt) : NaN;
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) return deny('campaign_window_invalid');
  if (startsAt > now) return deny('campaign_not_started');
  if (endsAt <= now) return deny('campaign_expired');
  return { eligible: true, reason: 'approved_campaign_active', campaignId: campaign.id, category: campaign.category, creativeVersion: campaign.creativeVersion };
}

function isValidTimestamp(value) {
  if (typeof value !== 'string') return false;
  // Require an explicit ISO-8601 timestamp with timezone; Date.parse accepts ambiguous inputs such as "1".
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const calendarDate = new Date(0);
  calendarDate.setUTCFullYear(year, month - 1, day);
  calendarDate.setUTCHours(hour, minute, second, 0);
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() + 1 !== month
    || calendarDate.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return false;

  const offset = match[8];
  if (offset.toUpperCase() !== 'Z') {
    const offsetHour = Number(offset.slice(1, 3));
    const offsetMinute = Number(offset.slice(4, 6));
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false;
  }
  return true;
}

function deny(reason) {
  return { eligible: false, reason };
}
