import test from 'node:test';
import assert from 'node:assert/strict';
import { isAccountUser, isBillingStatus } from './AccountAccessPanel.tsx';

const validUser = () => ({
  id: 'user-123',
  email: 'person@example.com',
  displayName: 'Alex',
  gender: 'female' as const,
  country: 'Georgia',
  city: 'Tbilisi',
  relationshipIntent: 'marriage_family' as const
});

test('accepts a valid account response and boundary-length fields', () => {
  const user = validUser();
  user.id = 'i'.repeat(256);
  user.email = `${'a'.repeat(242)}@example.com`; // 254 characters
  user.displayName = 'N'.repeat(100);
  user.country = 'C'.repeat(100);
  user.city = 'T'.repeat(100);
  assert.equal(isAccountUser(user), true);
});

test('rejects account responses with oversized identity and location fields', () => {
  for (const [field, value] of [
    ['id', 'i'.repeat(257)],
    ['email', `${'a'.repeat(243)}@example.com`],
    ['displayName', 'N'.repeat(101)],
    ['country', 'C'.repeat(101)],
    ['city', 'T'.repeat(101)]
  ] as const) {
    const user = { ...validUser(), [field]: value };
    assert.equal(isAccountUser(user), false, `${field} should respect its length limit`);
  }
});

test('rejects non-string identity and location fields', () => {
  for (const field of ['id', 'email', 'displayName', 'country', 'city'] as const) {
    for (const value of [null, 42, {}, []]) {
      const user = { ...validUser(), [field]: value };
      assert.equal(isAccountUser(user), false, `${field} should reject ${String(value)}`);
    }
  }
});

test('rejects missing required values and invalid enum values', () => {
  assert.equal(isAccountUser({ ...validUser(), displayName: '   ' }), false);
  assert.equal(isAccountUser({ ...validUser(), gender: 'other' }), false);
  assert.equal(isAccountUser({ ...validUser(), relationshipIntent: 'casual' }), false);
  assert.equal(isAccountUser(null), false);
  assert.equal(isAccountUser([]), false);
});

test('accepts valid billing status response from the API', () => {
  assert.equal(isBillingStatus({
    access: 'full',
    trialEndsAt: '2026-10-30T12:00:00.000Z',
    premiumUntil: null,
    paymentConfigured: true
  }), true);
  assert.equal(isBillingStatus({
    access: 'premium_required',
    trialEndsAt: null,
    premiumUntil: null,
    paymentConfigured: false
  }), true);
});

test('rejects malformed billing status response fields', () => {
  const valid = {
    access: 'full',
    trialEndsAt: null,
    premiumUntil: null,
    paymentConfigured: false
  };
  for (const invalid of [
    { ...valid, access: 'unlimited' },
    { ...valid, trialEndsAt: 'not-a-date' },
    { ...valid, premiumUntil: 42 },
    { ...valid, paymentConfigured: 'false' },
    null,
    []
  ]) {
    assert.equal(isBillingStatus(invalid), false);
  }
});

test('rejects empty, whitespace-only, and overlong billing timestamps', () => {
  const valid = {
    access: 'full',
    trialEndsAt: null,
    premiumUntil: null,
    paymentConfigured: true
  };
  for (const timestamp of ['', '   ', 'not-a-date', '2026-10-30T12:00:00.000Z'.padEnd(41, ' ')]) {
    assert.equal(isBillingStatus({ ...valid, trialEndsAt: timestamp }), false, `should reject ${JSON.stringify(timestamp)}`);
    assert.equal(isBillingStatus({ ...valid, premiumUntil: timestamp }), false, `should reject ${JSON.stringify(timestamp)}`);
  }
});

test('rejects blank required account identity fields after trimming', () => {
  for (const field of ['id', 'email', 'displayName'] as const) {
    for (const value of ['', '   ', '\t\n']) {
      assert.equal(isAccountUser({ ...validUser(), [field]: value }), false, field + ' should reject blank whitespace');
    }
  }
});


test('rejects account responses missing required identity and intent fields', () => {
  for (const field of ['id', 'email', 'displayName', 'gender', 'relationshipIntent'] as const) {
    assert.equal(isAccountUser({ ...validUser(), [field]: undefined }), false, `${field} is required`);
    assert.equal(isAccountUser({ ...validUser(), [field]: null }), false, `${field} must not be null`);
  }
});


test('rejects primitive account payloads and non-string enum fields', () => {
  for (const value of [undefined, true, false, 0, 1, 'account', Symbol('account')]) {
    assert.equal(isAccountUser(value), false, `should reject primitive payload ${typeof value}`);
  }
  for (const field of ['gender', 'relationshipIntent'] as const) {
    for (const value of [null, 42, {}, []]) {
      assert.equal(isAccountUser({ ...validUser(), [field]: value }), false, `${field} should reject malformed enum values`);
    }
  }
});


test('accepts empty optional location strings and ignores additional response fields', () => {
  assert.equal(isAccountUser({
    ...validUser(),
    country: '',
    city: '',
    serverMetadata: { source: 'api' }
  }), true);
});


test('accepts each empty optional location field independently', () => {
  assert.equal(isAccountUser({ ...validUser(), country: '' }), true);
  assert.equal(isAccountUser({ ...validUser(), city: '' }), true);
});
