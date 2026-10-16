import type { UserProfile } from '../types/index.ts';

/**
 * Matches a profile against optional country and city text filters.
 * An empty/"all" filter means no restriction. Missing profile countries do not
 * get guessed; a country-specific search only matches an explicitly stored country.
 */
export function matchesProfileLocation(
  profile: Pick<UserProfile, 'country' | 'city'>,
  selectedCountry: string,
  selectedCity: string
): boolean {
  const countryQuery = selectedCountry.trim();
  const cityQuery = selectedCity.trim();

  const countryMatches =
    !countryQuery ||
    countryQuery.toLocaleLowerCase() === 'all' ||
    (profile.country ?? '').toLocaleLowerCase().includes(countryQuery.toLocaleLowerCase());

  const cityMatches =
    !cityQuery ||
    cityQuery.toLocaleLowerCase() === 'all' ||
    profile.city.toLocaleLowerCase().includes(cityQuery.toLocaleLowerCase());

  return countryMatches && cityMatches;
}
