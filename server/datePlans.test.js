import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDatePlanInput } from './datePlans.js';

const validInput = (overrides = {}) => ({
  venueName: 'Central Park Cafe',
  startsAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  timeZone: 'Europe/Tbilisi',
  isPublicVenue: true,
  ...overrides
});

test('accepts a bounded public venue proposal with explicit timezone and offset', () => {
  const result = normalizeDatePlanInput(validInput());
  assert.ok(result);
  assert.equal(result.venueName, 'Central Park Cafe');
  assert.equal(result.timeZone, 'Europe/Tbilisi');
  assert.ok(result.startsAt instanceof Date);
});

test('rejects private-place attestations, missing fields and unsafe venue names', () => {
  assert.equal(normalizeDatePlanInput(validInput({ isPublicVenue: false })), null);
  assert.equal(normalizeDatePlanInput(validInput({ venueName: 'x' })), null);
  assert.equal(normalizeDatePlanInput(validInput({ venueName: 'Home\nAddress' })), null);
  assert.equal(normalizeDatePlanInput(validInput({ timeZone: '' })), null);
  assert.equal(normalizeDatePlanInput(validInput({ timeZone: 'Not/A_Zone' })), null);
});

test('rejects ambiguous local datetimes without an explicit UTC offset', () => {
  assert.equal(normalizeDatePlanInput(validInput({ startsAt: '2026-11-10T18:30' })), null);
  assert.equal(normalizeDatePlanInput(validInput({ startsAt: '2026-02-31T18:30:00Z' })), null);
});

test('rejects proposals that are too soon or more than 90 days away', () => {
  assert.equal(normalizeDatePlanInput(validInput({ startsAt: new Date(Date.now() + 5 * 60_000).toISOString() })), null);
  assert.equal(normalizeDatePlanInput(validInput({ startsAt: new Date(Date.now() + 91 * 86_400_000).toISOString() })), null);
});
