import test from 'node:test';
import assert from 'node:assert/strict';
import { isCurrentDiscoverySearchResponse, isSafeProfilePhotoUrl, normalizeFemaleDailyQuota, isFemaleWeeklyMatchQuotaExhausted } from './ServerDiscoveryPanel.tsx';

test('server profile photos must use private same-origin photo assets', () => {
  assert.equal(
    isSafeProfilePhotoUrl('/api/photos/123e4567-e89b-12d3-a456-426614174000'),
    true
  );
  for (const value of [
    'https://tracker.example/photo.jpg',
    'http://images.example/photo.jpg',
    '//tracker.example/photo.jpg',
    '/uploads/private/photo.jpg',
    '/api/photos/not-a-uuid',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    ' /api/photos/123e4567-e89b-12d3-a456-426614174000',
    '/api/photos/123e4567-e89b-12d3-a456-426614174000?track=1'
  ]) {
    assert.equal(isSafeProfilePhotoUrl(value), false, String(value));
  }
});

test('discovery ignores a response parsed after a newer search or account session starts', () => {
  assert.equal(isCurrentDiscoverySearchResponse(4, 4, 2, 2), true);
  assert.equal(isCurrentDiscoverySearchResponse(4, 5, 2, 2), false,
    'a newer filter/search request invalidates the earlier response');
  assert.equal(isCurrentDiscoverySearchResponse(4, 4, 2, 3), false,
    'a session switch invalidates a response even when its body resolves later');
  assert.equal(isCurrentDiscoverySearchResponse(0, 0, 2, 2), false);
  assert.equal(isCurrentDiscoverySearchResponse(4, 4, Number.NaN, 2), false);
});


test('female daily quota payloads are validated before being displayed', () => {
  assert.deepEqual(normalizeFemaleDailyQuota({ limit: 3, used: 2, remaining: 1, timezone: 'UTC' }), {
    limit: 3, used: 2, remaining: 1, timezone: 'UTC'
  });
  assert.equal(normalizeFemaleDailyQuota({ limit: 3, used: 3, remaining: 0, timezone: 'UTC' })?.remaining, 0);
  assert.equal(normalizeFemaleDailyQuota({ limit: 3, used: 3, remaining: 1, timezone: 'UTC' }), null);
  assert.equal(normalizeFemaleDailyQuota({ limit: 4, used: 1, remaining: 3, timezone: 'UTC' }), null);
  assert.equal(normalizeFemaleDailyQuota({ limit: 3, used: -1, remaining: 4, timezone: 'UTC' }), null);
  assert.equal(normalizeFemaleDailyQuota(null), null);
});

test('weekly match quota exhaustion is recognized only for an explicit exhausted quota response', () => {
  assert.equal(isFemaleWeeklyMatchQuotaExhausted({ type: 'weekly_matches', exhausted: true }), true);
  assert.equal(isFemaleWeeklyMatchQuotaExhausted({ type: 'weekly_matches', exhausted: false }), false);
  assert.equal(isFemaleWeeklyMatchQuotaExhausted({ type: 'daily_profiles', exhausted: true }), false);
  assert.equal(isFemaleWeeklyMatchQuotaExhausted(null), false);
});


test('stale daily profile actions refresh discovery and exhausted undo reports the quota', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./ServerDiscoveryPanel.tsx', import.meta.url), 'utf8');
  assert.match(source, /response\.status === 403 && data\?\.error === 'profile_not_issued_today'/);
  assert.equal((source.match(/await search\(\);\s*if \(actionEpoch === sessionEpoch\.current\) setNotice\(t\('profileNotIssuedToday'\)\);/g) || []).length, 2,
    'both stale likes and passes refresh discovery before showing the localized notice');
  assert.match(source, /response\.status === 429 && data\?\.error === 'daily_profile_limit_reached'/);
  assert.match(source, /setDailyQuota\(exhaustedQuota\)/);
  assert.match(source, /setNotice\(t\('femaleDailyQuotaExhausted'\)\)/);
});

test('undoing a like reissues the profile instead of restoring a cached card across UTC days', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./ServerDiscoveryPanel.tsx', import.meta.url), 'utf8');
  const undoStart = source.indexOf('const undoPass = async () => {');
  const reportStart = source.indexOf('const submitReport = async', undoStart);
  assert.ok(undoStart >= 0 && reportStart > undoStart, 'discovery undo handler exists');
  const undo = source.slice(undoStart, reportStart);
  const likeStart = undo.indexOf("if (lastAction?.type === 'like')");
  const likeEnd = undo.indexOf("const response = lastAction", likeStart);
  assert.ok(likeStart >= 0 && likeEnd > likeStart, 'undo-like branch exists');
  const unlike = undo.slice(likeStart, likeEnd);
  assert.ok(unlike.indexOf('await search();') > unlike.indexOf('setActionHistory('),
    'after removing the like, the card must be reissued by the server before it can be shown again');
  assert.doesNotMatch(unlike, /setProfiles\(current => current\.some\(item => item\.id === lastAction\.profile\.id\)/,
    'the old cached profile must not bypass the current UTC-day exposure reservation');
});

test('weekly match quota 429 responses are shown as quota notices, not generic send failures', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./ServerDiscoveryPanel.tsx', import.meta.url), 'utf8');
  const quotaCheck = source.indexOf('response.status === 429 && isFemaleWeeklyMatchQuotaExhausted(data?.quota)');
  const genericFailure = source.indexOf("if (!response.ok) throw new Error(t('sendLikeError'))");
  assert.ok(quotaCheck >= 0 && genericFailure > quotaCheck,
    'the explicit weekly quota response must be handled before the generic HTTP error');
});
