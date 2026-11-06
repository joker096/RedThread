import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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


test('profile pass and undo handlers acquire account locks before row locks and use one transaction', async () => {
  const source = await readFile(new URL('./index.js', import.meta.url), 'utf8');
  const routes = [
    "app.post('/api/passes/undo'",
    "app.post('/api/passes/:targetId'",
    "app.post('/api/discovery/undo'"
  ];
  for (const marker of routes) {
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, `route exists: ${marker}`);
    const next = source.indexOf('\\napp.', start + marker.length);
    const route = source.slice(start, next === -1 ? source.length : next);
    assert.equal((route.match(/await client\\.query\\('BEGIN'\\)/g) || []).length, 1,
      `${marker} must open exactly one transaction`);
    const accountLock = route.indexOf('await acquireGiftSafetyUserLocks(');
    const rowLock = route.search(/FOR (?:SHARE|UPDATE)/);
    assert.ok(accountLock >= 0 && rowLock > accountLock,
      `${marker} must acquire account advisory locks before row-level locks`);
  }
});
