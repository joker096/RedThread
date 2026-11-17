import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Paddle, Environment } from '@paddle/paddle-node-sdk';
import { unmarshalPaddleWebhook } from './paddleWebhookSignature.js';

const secret = 'vow_test_webhook_secret_only';
const paddle = new Paddle('test_api_key', { environment: Environment.sandbox });
const unmarshal = (body, webhookSecret, header) =>
  paddle.webhooks.unmarshal(body, webhookSecret, header);
const payload = {
  event_id: 'evt_01jvowwebhooktest000001',
  event_type: 'transaction.completed',
  occurred_at: '2026-11-17T10:00:00.000Z',
  notification_id: 'ntf_01jvowwebhooktest000001',
  data: {
    id: 'txn_01jvowwebhooktest000001',
    status: 'completed',
    currency_code: 'USD',
    details: { tax_rates_used: [], line_items: [], totals: { total: '990' } },
    items: [],
    payments: [],
    created_at: '2026-11-17T10:00:00.000Z',
    updated_at: '2026-11-17T10:00:00.000Z'
  }
};
const rawBody = JSON.stringify(payload);

function sign(body, timestamp, key = secret) {
  return createHmac('sha256', key).update(`${timestamp}:${body}`, 'utf8').digest('hex');
}

function verify(signature, body = rawBody) {
  return unmarshalPaddleWebhook({ unmarshal, rawBody: body, secret, signature });
}

test('accepts an authentic Paddle webhook using the raw request body', async () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const event = await verify(`ts=${timestamp};h1=${sign(rawBody, timestamp)}`);
  assert.equal(event.eventId, payload.event_id);
  assert.equal(event.eventType, payload.event_type);
});

test('rejects a tampered body even when the signature was valid for the original bytes', async () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = `ts=${timestamp};h1=${sign(rawBody, timestamp)}`;
  await assert.rejects(verify(signature, rawBody + ' '));
});

test('rejects expired signatures', async () => {
  const timestamp = Math.floor(Date.now() / 1000) - 10;
  await assert.rejects(verify(`ts=${timestamp};h1=${sign(rawBody, timestamp)}`));
});

test('rejects future-dated signatures', async () => {
  const timestamp = Math.floor(Date.now() / 1000) + 10;
  await assert.rejects(verify(`ts=${timestamp};h1=${sign(rawBody, timestamp)}`));
});

test('rejects malformed timestamps, missing hashes, duplicate timestamps and malformed HMAC values', async () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const validHash = sign(rawBody, timestamp);
  const malformed = [
    '',
    'invalid_header',
    `ts=abc;h1=${validHash}`,
    `ts=${timestamp};h2=${validHash}`,
    `ts=${timestamp};h1=not-a-hash`,
    `ts=${timestamp};ts=${timestamp};h1=${validHash}`,
    `ts=${timestamp};h1=${validHash};h1=short`
  ];
  for (const signature of malformed) {
    await assert.rejects(verify(signature));
  }
});

test('accepts any valid h1 among multiple signatures during secret rotation', async () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const validHash = sign(rawBody, timestamp);
  const invalidButWellFormedHash = '0'.repeat(64);

  const validAfterInvalid = await verify(
    `ts=${timestamp};h1=${invalidButWellFormedHash};h1=${validHash}`
  );
  assert.equal(validAfterInvalid.eventId, payload.event_id);

  const validBeforeInvalid = await verify(
    `ts=${timestamp};h1=${validHash};h1=${invalidButWellFormedHash}`
  );
  assert.equal(validBeforeInvalid.eventId, payload.event_id);
});
