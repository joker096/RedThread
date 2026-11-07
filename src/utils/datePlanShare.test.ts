import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDatePlanShareText, shareDatePlanText } from './datePlanShare.ts';

test('builds a minimal date plan message without account, contact or tracking data', () => {
  const result = buildDatePlanShareText(
    { place: 'Cafe near the park', day: 'Tomorrow', time: '19:00 (Asia/Tbilisi)' },
    { prefix: 'My confirmed Vow date plan:', reminder: 'This is a plan only; Vow does not track my location or confirm my return.' }
  );
  assert.equal(result, 'My confirmed Vow date plan:\nCafe near the park\nTomorrow, 19:00 (Asia/Tbilisi)\nThis is a plan only; Vow does not track my location or confirm my return.');
  assert.equal(result?.includes('email'), false);
  assert.equal(result?.includes('phone'), false);
  assert.equal(result?.includes('matchId'), false);
});

test('does not create a share message from incomplete or oversized plans', () => {
  const labels = { prefix: 'Date plan:', reminder: 'Plan only.' };
  assert.equal(buildDatePlanShareText({ place: '', day: 'Tomorrow', time: '19:00' }, labels), null);
  assert.equal(buildDatePlanShareText({ place: 'Cafe', day: '', time: '19:00' }, labels), null);
  assert.equal(buildDatePlanShareText({ place: 'Cafe', day: 'Tomorrow', time: '' }, labels), null);
  assert.equal(buildDatePlanShareText({ place: 'x'.repeat(301), day: 'Tomorrow', time: '19:00' }, labels), null);
});

test('normalizes line breaks in venue text before sharing', () => {
  const result = buildDatePlanShareText(
    { place: 'Cafe\nInjected line', day: 'Tomorrow', time: '19:00' },
    { prefix: 'Date plan:', reminder: 'Plan only.' }
  );
  assert.equal(result, 'Date plan:\nCafe Injected line\nTomorrow, 19:00\nPlan only.');
});

test('uses native share when available and does not copy after success', async () => {
  let copied = false;
  const result = await shareDatePlanText('Plan details', 'Vow date plan', {
    share: async payload => { assert.deepEqual(payload, { title: 'Vow date plan', text: 'Plan details' }); },
    copy: async () => { copied = true; }
  });
  assert.equal(result, 'shared');
  assert.equal(copied, false);
});

test('does not copy to clipboard when the user cancels the native share sheet', async () => {
  let copied = false;
  const result = await shareDatePlanText('Plan details', 'Vow date plan', {
    share: async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); },
    copy: async () => { copied = true; }
  });
  assert.equal(result, 'cancelled');
  assert.equal(copied, false);
});

test('falls back to clipboard when native sharing is unavailable or fails', async () => {
  let copied = '';
  const result = await shareDatePlanText('Plan details', 'Vow date plan', {
    share: async () => { throw new Error('native share unavailable'); },
    copy: async text => { copied = text; }
  });
  assert.equal(result, 'copied');
  assert.equal(copied, 'Plan details');
});

test('reports unavailable when neither native sharing nor clipboard succeeds', async () => {
  assert.equal(await shareDatePlanText('Plan details', 'Vow date plan', {}), 'unavailable');
  assert.equal(await shareDatePlanText('Plan details', 'Vow date plan', {
    copy: async () => { throw new Error('clipboard unavailable'); }
  }), 'unavailable');
});
