import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDatePlanShareText } from './datePlanShare.ts';

test('builds a minimal date plan message without account, contact or location-tracking data', () => {
  const result = buildDatePlanShareText(
    { place: 'Cafe near the park', day: 'Tomorrow', time: '19:00' },
    { prefix: 'My date is planned for:', reminder: 'I will message you after I get home.' }
  );
  assert.equal(result, 'My date is planned for:\nCafe near the park\nTomorrow, 19:00\nI will message you after I get home.');
  assert.equal(result?.includes('email'), false);
  assert.equal(result?.includes('phone'), false);
});

test('does not create a share message from incomplete or oversized plans', () => {
  const labels = { prefix: 'Date plan:', reminder: 'I will check in.' };
  assert.equal(buildDatePlanShareText({ place: '', day: 'Tomorrow', time: '19:00' }, labels), null);
  assert.equal(buildDatePlanShareText({ place: 'Cafe', day: '', time: '19:00' }, labels), null);
  assert.equal(buildDatePlanShareText({ place: 'Cafe', day: 'Tomorrow', time: '' }, labels), null);
  assert.equal(buildDatePlanShareText({ place: 'x'.repeat(301), day: 'Tomorrow', time: '19:00' }, labels), null);
});
