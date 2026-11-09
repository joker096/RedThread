import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  buildApnsPayload,
  buildFcmMessage,
  classifyApnsResponse,
  classifyFcmResponse,
  createApnsProviderToken,
  createFcmServiceAssertion,
  mobilePushRetryDelayMs
} from './mobilePushDelivery.js';

const payload = {
  title: 'Vow',
  body: 'You have a new message.',
  route: '/chats',
  data: { type: 'new_message', route: '/chats' }
};

test('FCM service assertion uses short-lived JWT claims and RS256', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwt = createFcmServiceAssertion({
    clientEmail: 'vow-push@example.iam.gserviceaccount.com',
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    nowSeconds: 1_800_000_000
  });
  const [header, claims, signature] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString()).alg, 'RS256');
  const decoded = JSON.parse(Buffer.from(claims, 'base64url').toString());
  assert.equal(decoded.iss, 'vow-push@example.iam.gserviceaccount.com');
  assert.equal(decoded.exp - decoded.iat, 3600);
  assert.ok(Buffer.from(signature, 'base64url').length > 200);
});

test('APNs provider token uses ES256 and a 64-byte raw signature', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwt = createApnsProviderToken({
    teamId: 'ABCDEFGHIJ',
    keyId: 'KLMNOPQRST',
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    nowSeconds: 1_800_000_000
  });
  const [header, claims, signature] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString()).alg, 'ES256');
  assert.equal(JSON.parse(Buffer.from(claims, 'base64url').toString()).iss, 'ABCDEFGHIJ');
  assert.equal(Buffer.from(signature, 'base64url').length, 64);
});

test('provider payloads contain only generic notification copy and allowlisted routes', () => {
  assert.deepEqual(buildFcmMessage('fcm-token', payload).message.data, {
    type: 'new_message', route: '/chats'
  });
  assert.deepEqual(buildApnsPayload(payload), {
    aps: { alert: { title: 'Vow', body: 'You have a new message.' }, sound: 'default' },
    type: 'new_message',
    route: '/chats'
  });
  assert.equal(JSON.stringify(buildFcmMessage('fcm-token', payload)).includes('messageId'), false);
});

test('provider responses distinguish sent, invalid token, retry and permanent failure', () => {
  assert.equal(classifyFcmResponse(200, { name: 'projects/vow/messages/1' }).outcome, 'sent');
  assert.equal(classifyFcmResponse(404, {}).outcome, 'invalid_token');
  assert.equal(classifyFcmResponse(503, {}).outcome, 'retry');
  assert.equal(classifyFcmResponse(400, {}).outcome, 'failed');
  assert.equal(classifyApnsResponse(200, {}).outcome, 'sent');
  assert.equal(classifyApnsResponse(410, { reason: 'Unregistered' }).outcome, 'invalid_token');
  assert.equal(classifyApnsResponse(429, {}).outcome, 'retry');
});

test('push retry backoff is bounded and rejects invalid attempts', () => {
  assert.equal(mobilePushRetryDelayMs(1), 30_000);
  assert.equal(mobilePushRetryDelayMs(2), 60_000);
  assert.equal(mobilePushRetryDelayMs(10), 15_360_000);
  assert.equal(mobilePushRetryDelayMs(100), 21_600_000);
  assert.throws(() => mobilePushRetryDelayMs(0), /attempt count/);
});
