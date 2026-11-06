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


test('daily exposure reservations pin one UTC date across every statement in a transaction', async () => {
  const source = await readFile(new URL('./index.js', import.meta.url), 'utf8');
  const helperStart = source.indexOf('async function reserveFemaleProfileExposure(');
  const helperEnd = source.indexOf('\nfunction requirePaidFeatures', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'exposure reservation helper exists');
  const helper = source.slice(helperStart, helperEnd);
  assert.equal((helper.match(/clock_timestamp\(\)/g) || []).length, 1,
    'undo reservations capture the UTC date exactly once');
  assert.doesNotMatch(helper, /statement_timestamp\(\)/,
    'undo reservations must not recalculate the date per statement');
  assert.match(helper, /exposure_date < \$2::date/);
  assert.match(helper, /exposure_date = \$3::date/);
  assert.match(helper, /VALUES \(\$1, \$2, \$3::date\)/);

  const searchStart = source.indexOf("app.get('/api/profiles/search'");
  const searchEnd = source.indexOf('\nfunction isUuid', searchStart);
  assert.ok(searchStart >= 0 && searchEnd > searchStart, 'profile search route exists');
  const search = source.slice(searchStart, searchEnd);
  assert.equal((search.match(/clock_timestamp\(\)/g) || []).length, 2,
    'Discovery captures the preview date and rechecks it after account locks');
  const previewDateCapture = search.indexOf('const previewDateResult = await client.query(');
  const previewQuery = search.indexOf('const preview = await client.query(searchSql, [...searchParams, previewDate])');
  const accountLocks = search.indexOf('await acquireGiftSafetyUserLocks(client, req.authUser.id, ...candidateIds)');
  const lockedDateCapture = search.indexOf('const lockedDateResult = await client.query(');
  const reservationStart = search.indexOf('const exposureDate = lockedExposureDate;');
  const reservationEnd = search.indexOf('result.dailyQuota = dailyQuota;', reservationStart);
  assert.ok(previewDateCapture >= 0 && previewQuery > previewDateCapture);
  assert.ok(accountLocks > previewQuery && lockedDateCapture > accountLocks);
  assert.ok(reservationStart > lockedDateCapture && reservationEnd > reservationStart);
  assert.doesNotMatch(search.slice(reservationStart, reservationEnd), /statement_timestamp\(\)/,
    'profile exposure reservations must use the post-lock UTC date');
  assert.match(search, /exposure_date < \$2::date/);
  assert.match(search, /exposure_date = \$2::date/);
  assert.match(search, /VALUES \(\$1, \$2, \$3::date\)/);
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
    const next = source.indexOf('\napp.', start + marker.length);
    const route = source.slice(start, next === -1 ? source.length : next);
    assert.equal((route.match(/await client\.query\('BEGIN'\)/g) || []).length, 1,
      `${marker} must open exactly one transaction`);
    const accountLock = route.indexOf('await acquireGiftSafetyUserLocks(');
    const rowLock = route.search(/FOR (?:SHARE|UPDATE)/);
    assert.ok(accountLock >= 0 && rowLock > accountLock,
      `${marker} must acquire account advisory locks before row-level locks`);
  }

  const passUndoStart = source.indexOf("app.post('/api/passes/undo'");
  const passUndoEnd = source.indexOf('\napp.', passUndoStart + 1);
  const passUndo = source.slice(passUndoStart, passUndoEnd);
  const lockedProfileLookup = passUndo.indexOf('const profileResult = await client.query(');
  assert.ok(lockedProfileLookup >= 0);
  const lockedProfileSql = passUndo.slice(lockedProfileLookup);
  assert.match(lockedProfileSql, /p\.gender <> 'male' OR EXISTS\s*\([\s\S]*?iv\.status = 'verified' AND iv\.provider_environment = 'live'[\s\S]*?identity_l3_has_active_approval\(p\.user_id\)/,
    'pass undo must recheck live L2 and active L3 for male profiles after acquiring account locks');
});

test('free-tier like and pass validate the same post-lock UTC date used by discovery issuance', async () => {
  const source = await readFile(new URL('./index.js', import.meta.url), 'utf8');
  for (const marker of [
    "app.post('/api/likes/:targetId'",
    "app.post('/api/passes/:targetId'"
  ]) {
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, `route exists: ${marker}`);
    const next = source.indexOf('\napp.', start + marker.length);
    const route = source.slice(start, next === -1 ? source.length : next);
    const lock = route.indexOf('await acquireGiftSafetyUserLocks(');
    const dateCapture = route.indexOf("SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date AS exposure_date");
    const issuedCheck = route.indexOf('AND exposure_date = $3::date');
    assert.ok(lock >= 0 && dateCapture > lock,
      `${marker} captures the UTC date only after account locks are held`);
    assert.ok(issuedCheck > dateCapture,
      `${marker} validates exposure against the captured UTC date`);
    assert.equal(route.includes("exposure_date = (statement_timestamp() AT TIME ZONE 'UTC')::date"), false,
      `${marker} must not use transaction-start time for the exposure day`);
  }
});

test('weekly match quota captures its rolling-window clock after account locks', async () => {
  const source = await readFile(new URL('./index.js', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/api/likes/:targetId'");
  const next = source.indexOf('\napp.', start + 1);
  const route = source.slice(start, next === -1 ? source.length : next);
  const lock = route.indexOf('await acquireGiftSafetyUserLocks(');
  const quotaClock = route.indexOf("SELECT clock_timestamp() AS quota_now");
  const quotaQuery = route.indexOf("created_at > $2::timestamptz - INTERVAL '7 days'");
  assert.ok(lock >= 0 && quotaClock > lock);
  assert.ok(quotaQuery > quotaClock);
  assert.match(route, /MAX\(created_at\) \+ INTERVAL '7 days' AS next_available_at/,
    'the next slot opens only when the newest counted match exits, leaving zero matches in the rolling window');
  assert.match(route, /created_at > \$2::timestamptz - INTERVAL '7 days'/,
    'a match exactly seven days old is outside the rolling window at its expiry instant');
  assert.equal(route.includes("created_at >= statement_timestamp() - INTERVAL '7 days'"), false);
});

test('new mutual matches use the wall-clock insertion time for the rolling quota window', async () => {
  const source = await readFile(new URL('./index.js', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/api/likes/:targetId'");
  const next = source.indexOf('\napp.', start + 1);
  const route = source.slice(start, next === -1 ? source.length : next);
  const insertAt = route.indexOf('INSERT INTO matches');
  assert.notEqual(insertAt, -1, 'mutual match creation SQL exists');
  const insert = route.slice(insertAt, route.indexOf('RETURNING id', insertAt));
  assert.ok(insert.includes('INSERT INTO matches (user_a_id, user_b_id, created_at)'));
  assert.ok(insert.includes('GREATEST($1::uuid, $2::uuid), clock_timestamp())'),
    'the stored match timestamp must be captured when the row is inserted, not at transaction start');
});

test('daily quota keeps previously issued profiles visible when the allowance is exhausted', async () => {
  const source = await readFile(new URL('./index.js', import.meta.url), 'utf8');
  const searchStart = source.indexOf("app.get('/api/profiles/search'");
  const searchEnd = source.indexOf('\nfunction isUuid', searchStart);
  const search = source.slice(searchStart, searchEnd);
  const issuedPriority = search.indexOf('FROM female_profile_exposures issued');
  const compatibilityOrder = search.indexOf('"compatibilityScore" DESC');
  assert.ok(issuedPriority >= 0 && compatibilityOrder > issuedPriority,
    'already-issued profiles must sort before unseen profiles for a free account');
  assert.ok(search.includes('issued.exposure_date = $12::date'),
    'issued-profile ordering must use the UTC date captured before preview');
  assert.ok(search.includes('const previewDateResult = await client.query('));
  assert.ok(search.includes('const lockedDateResult = await client.query('));
  assert.ok(search.includes('String(lockedExposureDate) !== String(previewDate)'));
  assert.ok(search.includes('p.user_id = ANY($13::uuid[])'));
  assert.ok(search.includes('if (attempt >= 2)'));
  assert.ok(search.includes("await client.query('ROLLBACK');"),
    'a preview that crosses UTC midnight must roll back before retrying');
  assert.ok(search.includes('const lockedPreview = await client.query(searchSql, [...searchParams, previewDate])'));
  assert.ok(search.includes('lockedCandidateIds.some('),
    'candidate IDs must be revalidated after account locks before the final restricted query');
  assert.match(search, /hasMoreIssuedCandidates = result\.rows\.length > parsedLimit/);
  assert.match(search, /if \(usedBefore \+ newlyIssued >= FEMALE_FREE_DAILY_PROFILE_LIMIT\) continue;/,
    'an unseen profile at the exhausted quota must not stop later already-issued profiles from being returned');
  assert.match(search, /hasMoreIssuedCandidates/);
});
