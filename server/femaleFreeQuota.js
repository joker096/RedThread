export const FEMALE_FREE_DAILY_PROFILE_LIMIT = 3;
export const FEMALE_FREE_WEEKLY_MATCH_LIMIT = 1;

function timestamp(value) {
  if (value == null || value === '') return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

/** A free-tier female account is one without an active trial or Premium entitlement. */
export function isFemaleFreeAccount(account, now = Date.now()) {
  if (!account || account.gender !== 'female' || account.premium_lifetime === true) return false;
  return timestamp(account.female_trial_ends_at) <= now &&
    timestamp(account.premium_until) <= now;
}

/**
 * Keep previously exposed profiles repeatable, but never expose more than the
 * remaining daily allowance as new unique profiles. IDs are normalized because
 * PostgreSQL UUID values and test fixtures may differ in casing.
 */
export function selectProfilesWithinDailyQuota(profiles, viewedIds, requestedLimit = 50) {
  const seen = new Set([...viewedIds].map(id => String(id).toLowerCase()));
  const selected = [];
  const newProfileIds = [];
  const selectedIds = new Set();
  const limit = Math.max(0, Math.min(Number.isInteger(requestedLimit) ? requestedLimit : 50,
    FEMALE_FREE_DAILY_PROFILE_LIMIT));
  let hasMore = false;

  for (const profile of profiles) {
    const id = String(profile?.id || '').toLowerCase();
    if (!id || selectedIds.has(id)) continue;
    if (selected.length >= limit) {
      hasMore = true;
      continue;
    }
    if (!seen.has(id)) {
      if (seen.size + newProfileIds.length >= FEMALE_FREE_DAILY_PROFILE_LIMIT) {
        hasMore = true;
        continue;
      }
      newProfileIds.push(id);
    }
    selected.push(profile);
    selectedIds.add(id);
  }

  return { profiles: selected, newProfileIds, hasMore };
}
