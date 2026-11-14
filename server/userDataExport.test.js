import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUserDataExport } from './userDataExport.js';

const USER_ID = 'd2f4e2a4-6f5c-4f87-9d1d-4b6c6f80c9c1';

test('user data export returns a versioned package with only explicitly safe account fields', async () => {
  const statements = [];
  const db = {
    async query(sql, params) {
      statements.push(sql);
      assert.deepEqual(params, [USER_ID], 'every export query must be scoped to the authenticated user');
      if (/FROM users/.test(sql)) {
        return { rows: [{
          id: USER_ID,
          email: 'member@example.test',
          role: 'member',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
          phone_e164: '+995555000000',
          phone_verified_at: null,
          female_trial_ends_at: null,
          premium_until: null
        }] };
      }
      if (/FROM profiles p/.test(sql)) return { rows: [{ data: { display_name: 'Member' } }] };
      if (/FROM photo_assets/.test(sql)) return { rows: [{
        id: 'b0e6d5a1-12a1-4d51-9d2c-a7d3cc5b1190',
        mime_type: 'image/jpeg', byte_size: 1200, width: 800, height: 600,
        created_at: '2026-11-12T00:00:00.000Z',
        downloadPath: '/api/account/export/media/photo/b0e6d5a1-12a1-4d51-9d2c-a7d3cc5b1190'
      }] };
      if (/FROM profile_voice_intros vi/.test(sql)) return { rows: [{
        id: 'c0e6d5a1-12a1-4d51-9d2c-a7d3cc5b1190',
        mime_type: 'audio/mp4', byte_size: 9000, duration_ms: 20000,
        review_status: 'approved', downloadPath: '/api/account/export/media/voice-intro/c0e6d5a1-12a1-4d51-9d2c-a7d3cc5b1190'
      }] };
      return { rows: [] };
    }
  };

  const generatedAt = new Date('2026-11-12T12:00:00.000Z');
  const result = await buildUserDataExport(db, USER_ID, generatedAt);

  assert.equal(result.format, 'vow-user-data-export');
  assert.equal(result.version, 1);
  assert.equal(result.generatedAt, generatedAt.toISOString());
  assert.equal(result.account.email, 'member@example.test');
  assert.equal(result.profile.display_name, 'Member');
  assert.deepEqual(result.messages, []);
  assert.deepEqual(result.gifts.orders, []);
  assert.equal(result.photos[0].downloadPath, '/api/account/export/media/photo/b0e6d5a1-12a1-4d51-9d2c-a7d3cc5b1190');
  assert.equal(result.voiceIntroduction.downloadPath, '/api/account/export/media/voice-intro/c0e6d5a1-12a1-4d51-9d2c-a7d3cc5b1190');
  assert.ok(statements.length >= 20, 'export should include the declared personal-data collections');

  const sql = statements.join('\n').toLowerCase();
  for (const forbidden of [
    'password_hash', 'session_token', 'refresh_token', 'address_vault_ref',
    'storage_path', 'private_storage_key', 'provider_session_id',
    'paddle_customer_id', 'subscription_id', 'idempotency_key'
  ]) {
    assert.equal(sql.includes(forbidden), false, `export query must not select ${forbidden}`);
  }
  assert.equal(Object.hasOwn(result.account, 'password_hash'), false);
  assert.equal(Object.hasOwn(result.account, 'paddle_customer_id'), false);
});

test('user data export stops when the account is not active or does not exist', async () => {
  let calls = 0;
  const db = {
    async query(sql, params) {
      calls += 1;
      assert.match(sql, /status = 'active'/);
      assert.deepEqual(params, [USER_ID]);
      return { rows: [] };
    }
  };

  assert.equal(await buildUserDataExport(db, USER_ID), null);
  assert.equal(calls, 1, 'no personal-data collections should be queried for an inactive account');
});

test('user data export rejects invalid database clients and user identifiers', async () => {
  await assert.rejects(() => buildUserDataExport(null, USER_ID), /database client is required/);
  await assert.rejects(() => buildUserDataExport({ query() {} }, ''), /userId is required/);
});
