export const FEMALE_FREE_DAILY_PROFILE_LIMIT = 3;
export const FEMALE_FREE_MATCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const FEMALE_FREE_MATCH_LIMIT = 1;

export function hasFemalePremiumAccess(user, now = Date.now()) {
  if (!user || user.gender !== 'female') return true;
  if (user.premium_lifetime === true) return true;
  const premiumUntil = user.premium_until ? new Date(user.premium_until).getTime() : 0;
  const trialEndsAt = user.female_trial_ends_at ? new Date(user.female_trial_ends_at).getTime() : 0;
  return premiumUntil > now || trialEndsAt > now;
}

export function remainingFemaleDailyProfiles(used) {
  return Math.max(0, FEMALE_FREE_DAILY_PROFILE_LIMIT - Math.max(0, Number(used) || 0));
}

export function canCreateFemaleFreeMatch(recentMatches) {
  return Math.max(0, Number(recentMatches) || 0) < FEMALE_FREE_MATCH_LIMIT;
}
