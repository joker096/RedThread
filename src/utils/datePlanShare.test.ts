import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('changing a proposed venue resets the public-place attestation', async () => {
  const source = await readFile(new URL('./DatePlanPanel.tsx', import.meta.url), 'utf8');
  assert.match(source, /if \(nextVenue !== venueName\) setIsPublicVenue\(false\)/);
});

test('date-plan action errors remain visible after the state refresh', async () => {
  const source = await readFile(new URL('./DatePlanPanel.tsx', import.meta.url), 'utf8');
  assert.match(source, /const actionError = cause instanceof Error[\s\S]*?await refresh\(\);\s*setError\(actionError\);/);
});

import { buildDatePlanShareText, shareDatePlanText } from '../utils/datePlanShare.ts';

test('confirmed date sharing contains only the public venue label and plan time', () => {
  const result = buildDatePlanShareText({
    venueName: 'Public Cafe',
    dateTime: 'Nov 8, 2026, 7:00 PM',
    timeZone: 'Asia/Tbilisi'
  }, {
    prefix: 'Our confirmed date plan:',
    reminder: 'Plan only; Vow does not track location or confirm return.'
  });
  assert.equal(result, 'Our confirmed date plan:\\nPublic Cafe\\nNov 8, 2026, 7:00 PM (Asia/Tbilisi)\\nPlan only; Vow does not track location or confirm return.');
  assert.equal(result?.includes('email'), false);
  assert.equal(result?.includes('phone'), false);
});

test('share text normalizes line breaks and rejects incomplete or oversized values', () => {
  const labels = { prefix: 'Plan:', reminder: 'Plan only.' };
  assert.equal(buildDatePlanShareText({ venueName: 'Cafe\\nInjected', dateTime: 'Tomorrow', timeZone: 'UTC' }, labels), 'Plan:\\nCafe Injected\\nTomorrow (UTC)\\nPlan only.');
  assert.equal(buildDatePlanShareText({ venueName: '', dateTime: 'Tomorrow', timeZone: 'UTC' }, labels), null);
  assert.equal(buildDatePlanShareText({ venueName: 'x'.repeat(121), dateTime: 'Tomorrow', timeZone: 'UTC' }, labels), null);
});

test('native share success reports shared', async () => {
  let shared: unknown;
  const result = await shareDatePlanText('Plan', 'Title', {
    share: async value => { shared = value; }
  });
  assert.equal(result, 'shared');
  assert.deepEqual(shared, { title: 'Title', text: 'Plan' });
});

test('native share cancellation does not silently copy', async () => {
  let copied = false;
  const result = await shareDatePlanText('Plan', 'Title', {
    share: async () => { throw Object.assign(new Error('dismissed'), { name: 'AbortError' }); },
    writeText: async () => { copied = true; }
  });
  assert.equal(result, 'cancelled');
  assert.equal(copied, false);
});

test('native share failure falls back to clipboard', async () => {
  let copied = '';
  const result = await shareDatePlanText('Plan', 'Title', {
    share: async () => { throw new Error('share unavailable'); },
    writeText: async value => { copied = value; }
  });
  assert.equal(result, 'copied');
  assert.equal(copied, 'Plan');
});

test('clipboard success works when native sharing is unavailable', async () => {
  const result = await shareDatePlanText('Plan', 'Title', {
    writeText: async () => undefined
  });
  assert.equal(result, 'copied');
});

test('clipboard failure returns unavailable without exposing an exception', async () => {
  const result = await shareDatePlanText('Plan', 'Title', {
    writeText: async () => { throw new Error('permission denied'); }
  });
  assert.equal(result, 'unavailable');
});
