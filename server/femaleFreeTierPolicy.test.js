import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEMALE_FREE_DAILY_PROFILE_LIMIT,
  FEMALE_FREE_MATCH_LIMIT,
  hasFemalePremiumAccess,
  remainingFemaleDailyProfiles,
  canCreateFemaleFreeMatch
} from './femaleFreeTierPolicy.js';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');

test('female premium entitlement includes active trial, paid subscription and lifetime access', () => {
  assert.equal(hasFemalePremiumAccess({ gender: 'female', female_trial_ends_at: new Date(NOW + 1).toISOString() }, NOW), true);
  assert.equal(hasFemalePremiumAccess({ gender: 'female', premium_until: new Date(NOW + 1).toISOString() }, NOW), true);
  assert.equal(hasFemalePremiumAccess({ gender: 'female', premium_lifetime: true }, NOW), true);
  assert.equal(hasFemalePremiumAccess({ gender: 'female' }, NOW), false);
  assert.equal(hasFemalePremiumAccess({ gender: 'male' }, NOW), true);
});

test('daily profile allowance is capped at three unique issued profiles', () => {
  assert.equal(FEMALE_FREE_DAILY_PROFILE_LIMIT, 3);
  assert.equal(remainingFemaleDailyProfiles(0), 3);
  assert.equal(remainingFemaleDailyProfiles(1), 2);
  assert.equal(remainingFemaleDailyProfiles(3), 0);
  assert.equal(remainingFemaleDailyProfiles(99), 0);
});

test('free women may create only one new match in the rolling seven-day window', () => {
  assert.equal(FEMALE_FREE_MATCH_LIMIT, 1);
  assert.equal(canCreateFemaleFreeMatch(0), true);
  assert.equal(canCreateFemaleFreeMatch(1), false);
  assert.equal(canCreateFemaleFreeMatch(2), false);
});
