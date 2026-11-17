import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { processOneGiftProviderEvent } from './process-gift-provider-event.js';

const { Pool } = pg;

test('gift provider event processor fails closed without an explicit sandbox account configuration', async () => {
  let calls = 0;
  await assert.rejects(
    processOneGiftProviderEvent({
      pool: { query: async () => { calls += 1; }, connect: async () => { calls += 1; } },
      providers: {}
    }),
    error => error.code === 'gift_provider_event_processor_not_configured'
  );
  assert.equal(calls, 0);
});

test('PostgreSQL gift event processor binds exact attempt identity, wakes only existing work, and is concurrency safe', {
  skip: !process.env.DATABASE_URL,
  timeout: 30_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
  const client = await pool.connect();
  const senderId = randomUUID();
  const recipientId = randomUUID();
  const matchId = randomUUID();
  const orderId = randomUUID();
  const attemptId = randomUUID();
  const eventId = `evt_${randomUUID()}`;
  const reference = `txn_${randomUUID()}`;
  const providerKey = 'sandbox_provider';
  const accountId = 'acct_sandbox_test';
  const payloadHash = 'a'.repeat(64);
  const providers = { [providerKey]: { accountId, environment: 'sandbox' } };
  try {
    for (const [id, suffix] of [[senderId, 'sender'], [recipientId, 'recipient']]) {
      await client.query(
        "INSERT INTO users (id, email, role, status, email_verified_at) VALUES ($1, $2, 'member', 'active', NOW())",
        [id, `gift-event-${suffix}-${randomUUID()}@example.invalid`]
      );
    }
    await client.query(
      "INSERT INTO matches (id, user_a_id, user_b_id, status, created_at) VALUES ($1, LEAST($2::uuid, $3::uuid), GREATEST($2::uuid, $3::uuid), 'active', NOW())",
      [matchId, senderId, recipientId]
    );
    await client.query(
      "INSERT INTO gift_delivery_orders (id, match_id, sender_id, recipient_id, product_name_snapshot, product_category, total_minor_units, currency, idempotency_key, status, payment_status) VALUES ($1, $2, $3, $4, 'Inbox test gift', 'chocolate', 12500, 'GEL', $5, 'awaiting_recipient_consent', 'authorized')",
      [orderId, matchId, senderId, recipientId, `gift-event-${orderId}`]
    );
    await client.query(
      "INSERT INTO gift_payment_attempt_identity (order_id, attempt_id, provider_key, provider_reference, idempotency_key, amount_minor_units, currency) VALUES ($1, $2, $3, $4, $5, 12500, 'GEL')",
      [orderId, attemptId, providerKey, reference, `gift-event-idem-${orderId}`]
    );
    await client.query(
      "INSERT INTO gift_payment_reconciliation_tasks (order_id, reason, next_attempt_at) VALUES ($1, 'recipient_opted_out', TIMESTAMPTZ '2999-01-01 00:00:00+00')",
      [orderId]
    );
    const recorded = await client.query(
      'SELECT record_verified_gift_provider_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result',
      [providerKey, eventId, 'transaction.updated', payloadHash, new Date().toISOString(),
        accountId, 'sandbox', reference, 12500, 'GEL']
    );
    assert.equal(recorded.rows[0].result, 'inserted');

    const [a, b] = await Promise.all([
      processOneGiftProviderEvent({ pool, providers, workerId: 'gift-event-worker-a' }),
      processOneGiftProviderEvent({ pool, providers, workerId: 'gift-event-worker-b' })
    ]);
    assert.equal([a, b].filter(value => value.processed).length, 1);
    assert.equal([a, b].filter(value => value.claimed === false).length, 1);

    const event = await client.query(
      'SELECT processing_status, matched_attempt_id, lease_generation, attempt_count, quarantine_code FROM gift_payment_provider_event_inbox WHERE provider_key = $1 AND provider_event_id = $2',
      [providerKey, eventId]
    );
    assert.equal(event.rows[0].processing_status, 'processed');
    assert.equal(event.rows[0].matched_attempt_id, attemptId);
    assert.equal(Number(event.rows[0].lease_generation), 1);
    assert.equal(Number(event.rows[0].attempt_count), 1);
    assert.equal(event.rows[0].quarantine_code, null);

    const task = await client.query(
      'SELECT next_attempt_at FROM gift_payment_reconciliation_tasks WHERE order_id = $1',
      [orderId]
    );
    assert.ok(new Date(task.rows[0].next_attempt_at).getTime() < Date.now() + 60_000,
      'matched webhook must make only an existing reconciliation task due');
    const payment = await client.query(
      'SELECT payment_status FROM gift_delivery_orders WHERE id = $1',
      [orderId]
    );
    assert.equal(payment.rows[0].payment_status, 'authorized',
      'event processing is evidence/routing only and must never mutate payment state');
  } finally {
    client.release();
    await pool.end();
  }
});

test('PostgreSQL event processor quarantines unknown references and amount/currency mismatches', {
  skip: !process.env.DATABASE_URL,
  timeout: 20_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const providerKey = 'sandbox_provider';
  const providers = { [providerKey]: { accountId: 'acct_sandbox_test', environment: 'sandbox' } };
  const cases = [
    { reference: `unknown_${randomUUID()}`, amount: 1000, currency: 'GEL', code: 'payment_identity_unknown' },
  ];
  try {
    for (const scenario of cases) {
      const eventId = `evt_${randomUUID()}`;
      await pool.query(
        'SELECT record_verified_gift_provider_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [providerKey, eventId, 'transaction.updated', 'b'.repeat(64), new Date().toISOString(),
          'acct_sandbox_test', 'sandbox', scenario.reference, scenario.amount, scenario.currency]
      );
      const result = await processOneGiftProviderEvent({ pool, providers, workerId: `quarantine-${randomUUID()}` });
      assert.equal(result.quarantined, true);
      assert.equal(result.code, scenario.code);
    }
  } finally {
    await pool.end();
  }
});
