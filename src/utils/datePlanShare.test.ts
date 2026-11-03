import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDatePlanShareText } from './datePlanShare.ts';

test('builds a minimal date plan message without account, contact or location-tracking data', () => {
  const result = buildDatePlanShareText(
    { place: 'Cafe near the park', day: 'Tomorrow', time: '19:00' },
    { prefix: 'My planned date details:', reminder: 'This is a plan only; Vow does not track my location or confirm my return.' }
  );
  assert.equal(result, 'My planned date details:\nCafe near the park\nTomorrow, 19:00\nThis is a plan only; Vow does not track my location or confirm my return.');
  assert.equal(result?.includes('email'), false);
  assert.equal(result?.includes('phone'), false);
});

test('does not create a share message from incomplete or oversized plans', () => {
  const labels = { prefix: 'Date plan:', reminder: 'Plan only.' };
  assert.equal(buildDatePlanShareText({ place: '', day: 'Tomorrow', time: '19:00' }, labels), null);
  assert.equal(buildDatePlanShareText({ place: 'Cafe', day: '', time: '19:00' }, labels), null);
  assert.equal(buildDatePlanShareText({ place: 'Cafe', day: 'Tomorrow', time: '' }, labels), null);
  assert.equal(buildDatePlanShareText({ place: 'x'.repeat(301), day: 'Tomorrow', time: '19:00' }, labels), null);
});

test('normalizes line breaks in user-provided place text', () => {
  const result = buildDatePlanShareText(
    { place: 'Cafe\nInjected line', day: 'Tomorrow', time: '19:00' },
    { prefix: 'Date plan:', reminder: 'Plan only.' }
  );
  assert.equal(result, 'Date plan:\nCafe Injected line\nTomorrow, 19:00\nPlan only.');
});
