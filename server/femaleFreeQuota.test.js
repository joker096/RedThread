import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEMALE_FREE_DAILY_PROFILE_LIMIT,
  FEMALE_FREE_WEEKLY_MATCH_LIMIT,
  isFemaleFreeAccount,
  selectProfilesWithinDailyQuota
} from './femaleFreeQuota.js';

test('female free-tier entitlement expires only after both trial and Premium end', () => {
  const now = Date.parse('2026-11-05T12:00:00.000Z');
  assert.equal(isFemaleFreeAccount({ gender: 'female' }, now), true);
  assert.equal(isFemaleFreeAccount({ gender: 'female', female_trial_ends_at: '2026-11-05T12:01:00Z' }, now), false);
  assert.equal(isFemaleFreeAccount({ gender: 'female', premium_until: '2026-11-06T00:00:00Z' }, now), false);
  assert.equal(isFemaleFreeAccount({ gender: 'female', premium_lifetime: true }, now), false);
  assert.equal(isFemaleFreeAccount({ gender: 'male' }, now), false);
});

test('daily discovery selects no more than three new unique profiles', () => {
  const profiles = [1, 2, 3, 4, 5].map(id => ({ id: String(id) }));
  const selected = selectProfilesWithinDailyQuota(profiles, new Set(), 50);
  assert.deepEqual(selected.profiles.map(profile => profile.id), ['1', '2', '3']);
  assert.deepEqual(selected.newProfileIds, ['1', '2', '3']);
  assert.equal(selected.hasMore, true);
});

test('repeat searches can return already viewed profiles without consuming quota again', () => {
  const profiles = [{ id: 'A' }, { id: 'b' }, { id: 'C' }, { id: 'D' }];
  const selected = selectProfilesWithinDailyQuota(profiles, new Set(['a', 'B']), 50);
  assert.deepEqual(selected.profiles.map(profile => profile.id), ['A', 'b', 'C']);
  assert.deepEqual(selected.newProfileIds, ['c']);
  assert.equal(selected.hasMore, true);
});

test('once the daily quota is full, unseen profiles are skipped but viewed profiles remain available', () => {
  const profiles = [{ id: 'new-1' }, { id: 'seen-1' }, { id: 'new-2' }, { id: 'seen-2' }];
  const selected = selectProfilesWithinDailyQuota(profiles, new Set(['seen-1', 'seen-2', 'seen-3']), 50);
  assert.deepEqual(selected.profiles.map(profile => profile.id), ['seen-1', 'seen-2']);
  assert.deepEqual(selected.newProfileIds, []);
  assert.equal(selected.hasMore, true);
});

test('free-tier quota constants match the product policy', () => {
  assert.equal(FEMALE_FREE_DAILY_PROFILE_LIMIT, 3);
  assert.equal(FEMALE_FREE_WEEKLY_MATCH_LIMIT, 1);
});
