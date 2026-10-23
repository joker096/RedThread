import { isValidEmail, normalizeEmail } from './security.js';

export const PROVIDER_APPLICATION_CATEGORIES = Object.freeze([
  'legal',
  'dress_rental',
  'photography',
  'videography',
  'host',
  'venue',
  'beauty',
  'cafe',
  'other'
]);

function boundedText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function normalizeHttpsUrl(value, maxLength = 2048) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > maxLength) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function normalizeProviderApplication(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'invalid_provider_application' };
  const contactName = boundedText(input.contactName, 120);
  const businessName = boundedText(input.businessName, 160);
  const email = typeof input.email === 'string' && input.email.trim().length <= 254
    ? normalizeEmail(input.email)
    : null;
  const category = typeof input.category === 'string' && PROVIDER_APPLICATION_CATEGORIES.includes(input.category)
    ? input.category
    : null;
  const country = boundedText(input.country, 100);
  const city = boundedText(input.city, 120);
  const serviceDescription = boundedText(input.serviceDescription, 1000);
  const websiteUrl = normalizeHttpsUrl(input.websiteUrl);
  const publicRegistryUrl = normalizeHttpsUrl(input.publicRegistryUrl, 1000);

  if (!contactName || !businessName || !email || !isValidEmail(email) || !category || !country || !city ||
      !serviceDescription || websiteUrl === undefined || publicRegistryUrl === undefined ||
      input.consent !== true) {
    return { error: 'invalid_provider_application' };
  }

  return {
    value: {
      contactName,
      businessName,
      email,
      category,
      country,
      city,
      serviceDescription,
      websiteUrl,
      publicRegistryUrl
    }
  };
}
