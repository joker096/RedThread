import test from 'node:test';
import assert from 'node:assert/strict';
import { isAccountUser } from './AccountAccessPanel.tsx';

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
