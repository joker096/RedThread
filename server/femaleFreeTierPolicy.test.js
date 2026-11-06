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
  const helperEnd = source.indexOf('\nasync function captureFemaleExposurePolicy', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'exposure reservation helper exists');
  const helper = source.slice(helperStart, helperEnd);
  assert.equal((helper.match(/clock_timestamp\(\)/g) || []).length, 1,
    'undo reservations capture the UTC date exactly once');
  assert.doesNotMatch(helper, /statement_timestamp\(\)/,
    'undo reservations must not recalculate the date per statement');
  assert.match(helper, /exposure_date < \$2::date/);
  assert.match(helper, /exposure_date = \$3::date/);
  assert.match(helper, /VALUES \(\$1, \$2, \$3::date\)/);
  assert.match(helper, /used: Number\(usage\.rows\[0\]\?\.used \|\| 0\), exposureDate, quotaApplied: true/,
    'an already-issued profile must retain the same commit-time quota snapshot as a newly reserved profile');

  const searchStart = source.indexOf("app.get('/api/profiles/search'");
  const searchEnd = source.indexOf('\nfunction isUuid', searchStart);
  assert.ok(searchStart >= 0 && searchEnd > searchStart, 'profile search route exists');
  const search = source.slice(searchStart, searchEnd);
  assert.equal((search.match(/clock_timestamp\(\)/g) || []).length, 3,
    'Discovery captures the preview date, rechecks after locks, and validates again before commit');
  const previewDateCapture = search.indexOf('const previewDateResult = await client.query(');
  const previewQuery = search.indexOf('const preview = await client.query(searchSql, [...searchParams, previewDate])');
  const accountLocks = search.indexOf('await acquireGiftSafetyUserLocks(client, req.authUser.id, ...candidateIds)');
  const lockedDateCapture = search.indexOf('const lockedDateResult = await client.query(');
  const reservationStart = search.indexOf('const exposureDate = lockedExposureDate;');
  const reservationEnd = search.indexOf('result.dailyQuota = dailyQuota;', reservationStart);
  const finalDateCapture = search.indexOf('const finalPolicyClock = await client.query(', reservationEnd);
  const finalCommit = search.indexOf("await client.query('COMMIT');", finalDateCapture);
  assert.ok(previewDateCapture >= 0 && previewQuery > previewDateCapture);
  assert.ok(accountLocks > previewQuery && lockedDateCapture > accountLocks);
  assert.ok(reservationStart > lockedDateCapture && reservationEnd > reservationStart);
  assert.ok(finalDateCapture > reservationEnd && finalCommit > finalDateCapture,
    'Discovery must revalidate the UTC day after all reservations and immediately before commit');
  assert.match(search.slice(finalDateCapture, finalCommit), /String\(finalPolicyClock\.rows\[0\]\.exposure_date\) !== String\(exposureDate\)/);
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
    const snapshotCapture = route.indexOf('captureFemaleExposurePolicy(');
    const issuedCheck = route.indexOf('AND exposure_date = $3::date');
    const helperStart = source.indexOf('async function captureFemaleExposurePolicy(');
    const helperEnd = source.indexOf('\nasync function femaleExposurePolicyChangedAtCommit', helperStart);
    const helper = source.slice(helperStart, helperEnd);
    assert.ok(lock >= 0 && snapshotCapture > lock,
      `${marker} captures the UTC date only after account locks are held`);
    assert.ok(issuedCheck > snapshotCapture,
      `${marker} validates exposure against the captured UTC date`);
    assert.match(helper, /clock_timestamp\(\)/);
    assert.match(helper, /AT TIME ZONE 'UTC'/);
    assert.equal(route.includes("statement_timestamp()"), false,
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
  assert.match(route, /hasFemalePremiumAccess\(femaleAccountForQuota, quotaNow\)/,
    'entitlement expiry and rolling-window counting must use the same PostgreSQL clock snapshot');
  assert.match(route, /MAX\(created_at\) \+ INTERVAL '7 days' AS next_available_at/,
    'the next slot opens only when the newest counted match exits, leaving zero matches in the rolling window');
  assert.match(route, /created_at > \$2::timestamptz - INTERVAL '7 days'/,
    'a match exactly seven days old is outside the rolling window at its expiry instant');
  assert.equal(route.includes("created_at >= statement_timestamp() - INTERVAL '7 days'"), false);
});

test('match creation rechecks Trial/Premium expiry at the transaction commit boundary', async () => {
  const source = await readFile(new URL('./index.js', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/api/likes/:targetId'");
  const next = source.indexOf('\napp.', start + 1);
  const route = source.slice(start, next === -1 ? source.length : next);
  const initialEntitlement = route.indexOf('femaleWasPremiumAtQuotaCheck');
  const matchInsert = route.indexOf('INSERT INTO matches');
  const finalClock = route.indexOf("SELECT clock_timestamp() AS quota_now", matchInsert);
  const finalEntitlement = route.indexOf('hasFemalePremiumAccess(', finalClock);
  const priorMatchCount = route.indexOf('recentMatchesAtCommit', finalEntitlement);
  const excludeNewMatch = route.indexOf('id <> $3::uuid', priorMatchCount);
  const rollback = route.indexOf("await client.query('ROLLBACK');", priorMatchCount);
  const commit = route.indexOf("await client.query('COMMIT');", rollback);
  assert.ok(initialEntitlement >= 0 && matchInsert > initialEntitlement);
  assert.ok(finalClock > matchInsert && finalEntitlement > finalClock);
  assert.ok(priorMatchCount > finalEntitlement && excludeNewMatch > priorMatchCount);
  assert.ok(rollback > priorMatchCount && commit > rollback,
    'an expired entitlement with a previously consumed slot must roll back the new like and match');
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


test('free-tier likes and passes revalidate entitlement and UTC exposure day before commit', async () => {
  const source = await readFile(new URL('./index.js', import.meta.url), 'utf8');
  for (const marker of [
    "app.post('/api/likes/:targetId'",
    "app.post('/api/passes/:targetId'"
  ]) {
    const start = source.indexOf(marker);
    const next = source.indexOf('\napp.', start + marker.length);
    const route = source.slice(start, next === -1 ? source.length : next);
    const lock = route.indexOf('await acquireGiftSafetyUserLocks(');
    const snapshot = route.indexOf('captureFemaleExposurePolicy(');
    const issuedCheck = route.indexOf('AND exposure_date = $3::date');
    const finalChecks = [...route.matchAll(/femaleExposurePolicyChangedAtCommit\(/g)].map(match => match.index);
    assert.ok(lock >= 0 && snapshot > lock,
      `${marker} must capture entitlement and UTC date after account locks`);
    assert.ok(issuedCheck > snapshot,
      `${marker} must validate the issued profile against the captured UTC date`);
    assert.ok(finalChecks.length >= (marker.includes('/likes/') ? 2 : 1),
      `${marker} must recheck the policy before every successful commit path`);
    assert.ok(route.includes('quota_policy_changed_retry'),
      `${marker} must return a refreshable conflict when the policy changes before commit`);
    for (const check of finalChecks) {
      const commit = route.indexOf("await client.query('COMMIT');", check);
      assert.ok(commit > check, `${marker} must recheck the policy before commit`);
    }
  }
});

test('undo endpoints revalidate the exposure UTC date immediately before returning a restored profile', async () => {
  const source = await readFile(new URL('./index.js', import.meta.url), 'utf8');
  for (const marker of ["app.post('/api/passes/undo'", "app.post('/api/discovery/undo'"]) {
    const start = source.indexOf(marker);
    const next = source.indexOf('\napp.', start + marker.length);
    const route = source.slice(start, next === -1 ? source.length : next);
    const reservation = route.indexOf('const exposure = await reserveFemaleProfileExposure(');
    const dateCheck = route.indexOf('const finalPolicyClock = await client.query(', reservation);
    const commit = route.indexOf("await client.query('COMMIT');", dateCheck);
    assert.ok(reservation >= 0 && dateCheck > reservation && commit > dateCheck,
      `${marker} must recheck the UTC day after reserving exposure and before commit`);
    assert.match(route.slice(dateCheck, commit), /quota_policy_changed_retry/);
  }
});
