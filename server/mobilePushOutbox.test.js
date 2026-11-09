import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptMobilePushToken } from './mobilePushTokens.js';
import { normalizeMobilePushBatchSize, processMobilePushOutboxBatch } from './mobilePushOutbox.js';

const key = Buffer.alloc(32, 7);
const token = 'fcm-token:abcdefghijklmnopqrstuvwxyz0123456789';
const env = { MOBILE_PUSH_TOKEN_ENCRYPTION_KEY: key.toString('hex') };

function fakePool({ outcome = { outcome: 'sent', providerMessageId: 'projects/vow/messages/1' }, attemptCount = 1 } = {}) {
  const statements = [];
  const client = {
    query: async (sql, params) => {
      statements.push({ sql: String(sql), params });
      if (String(sql).includes('WITH due AS')) {
        return { rows: [{ id: 'outbox-1', userId: 'user-1', tokenId: 'token-1', eventType: 'new_message', attemptCount }] };
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => {}
  };
  const pool = {
    connect: async () => client,
    query: async (sql, params) => {
      statements.push({ sql: String(sql), params });
      if (String(sql).startsWith('SELECT token.platform')) {
        return { rows: [{
          platform: 'android',
          tokenCiphertext: encryptMobilePushToken(token, key),
          tokenRevokedAt: null,
          sessionRevokedAt: null,
          refreshExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          recipientStatus: 'active'
        }] };
      }
      return { rows: [], rowCount: 1 };
    }
  };
  return { pool, statements, outcome };
}

test('mobile push batch size is bounded', () => {
  assert.equal(normalizeMobilePushBatchSize(100), 100);
  assert.throws(() => normalizeMobilePushBatchSize(0), /batch size/);
  assert.throws(() => normalizeMobilePushBatchSize(501), /batch size/);
});

test('outbox worker fails closed when token encryption is not configured', async () => {
  let connected = false;
  const result = await processMobilePushOutboxBatch({ connect: async () => { connected = true; } }, { env: {} });
  assert.deepEqual(result, { disabled: true, claimed: 0, sent: 0, retried: 0, failed: 0 });
  assert.equal(connected, false);
});

test('outbox worker decrypts only at send time and marks successful delivery', async () => {
  const { pool, statements } = fakePool();
  let delivered;
  const result = await processMobilePushOutboxBatch(pool, {
    env,
    send: async input => {
      delivered = input;
      return { outcome: 'sent', providerMessageId: 'projects/vow/messages/1' };
    }
  });
  assert.deepEqual(result, { disabled: false, claimed: 1, sent: 1, retried: 0, failed: 0 });
  assert.equal(delivered.token, token);
  assert.equal(delivered.platform, 'android');
  assert.equal(delivered.payload.body, 'You have a new message.');
  assert.ok(statements.some(item => item.sql.includes("SET status = 'sent'")));
});

test('outbox worker revokes provider-invalidated tokens and fails their delivery', async () => {
  const { pool, statements } = fakePool({ outcome: { outcome: 'invalid_token', errorCode: 'unregistered' } });
  const result = await processMobilePushOutboxBatch(pool, {
    env,
    send: async () => ({ outcome: 'invalid_token', errorCode: 'unregistered' })
  });
  assert.deepEqual(result, { disabled: false, claimed: 1, sent: 0, retried: 0, failed: 1 });
  assert.ok(statements.some(item => item.sql.includes("revoked_reason = 'provider_unregistered'")));
  assert.ok(statements.some(item => item.sql.includes("last_error_code = 'push_token_unregistered'")));
});

test('outbox worker schedules transient provider failures for retry', async () => {
  const { pool, statements } = fakePool({ attemptCount: 2 });
  const result = await processMobilePushOutboxBatch(pool, {
    env,
    send: async () => ({ outcome: 'retry', errorCode: 'provider_unavailable' })
  });
  assert.deepEqual(result, { disabled: false, claimed: 1, sent: 0, retried: 1, failed: 0 });
  assert.ok(statements.some(item => item.sql.includes("SET status = 'retry'")));
});
