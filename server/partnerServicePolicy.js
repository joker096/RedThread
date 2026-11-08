export const PARTNER_COUNTRY_CODES = Object.freeze(['GE', 'RU', 'KZ', 'AM']);
export const PARTNER_SERVICE_CATEGORIES = Object.freeze([
  'cafe', 'photography', 'videography', 'venue', 'beauty', 'legal',
  'transport', 'dress', 'host', 'other'
]);
export const PARTNER_SERVICE_CURRENCIES = Object.freeze(['USD', 'GEL', 'EUR', 'RUB', 'KZT', 'AMD']);

export function normalizePartnerCountry(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return PARTNER_COUNTRY_CODES.includes(code) ? code : null;
}

export function isPartnerServiceCategory(value) {
  return typeof value === 'string' && PARTNER_SERVICE_CATEGORIES.includes(value);
}

export function isPartnerServiceCurrency(value) {
  return typeof value === 'string' && PARTNER_SERVICE_CURRENCIES.includes(value);
}
