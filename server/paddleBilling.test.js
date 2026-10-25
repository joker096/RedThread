import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePaddleEvent, isPaddleSubscriptionEntitled } from './paddleBilling.js';

test('normalizes Paddle webhook snake_case and SDK camelCase envelopes', () => {
  assert.deepEqual(normalizePaddleEvent({ event_id: 'evt_1', event_type: 'subscription.updated', data: {} }), {
    eventId: 'evt_1', eventType: 'subscription.updated', data: {}, occurredAt: null
  });
  assert.equal(normalizePaddleEvent({ eventId: 'evt_2', eventType: 'transaction.completed', data: {} }).eventId, 'evt_2');
  assert.equal(normalizePaddleEvent({ event_type: 'subscription.updated' }), null);
});

test('only active or trialing subscriptions with a future billing period grant access', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(isPaddleSubscriptionEntitled('active', '2026-02-01T00:00:00Z', now), true);
  assert.equal(isPaddleSubscriptionEntitled('trialing', '2026-02-01T00:00:00Z', now), true);
  assert.equal(isPaddleSubscriptionEntitled('canceled', '2026-02-01T00:00:00Z', now), false);
  assert.equal(isPaddleSubscriptionEntitled('active', '2025-12-31T00:00:00Z', now), false);
  assert.equal(isPaddleSubscriptionEntitled('active', null, now), false);
});

test('malformed and unknown-status subscription events cannot be entitled', () => {
  assert.equal(normalizePaddleEvent(null), null);
  assert.equal(isPaddleSubscriptionEntitled('past_due', '2027-01-01T00:00:00Z', 0), false);
});



test('subscription lifecycle events require a valid source timestamp before database access', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  let connectCalls = 0;
  const pool = { async connect() { connectCalls += 1; throw new Error('should_not_connect'); } };

  await assert.rejects(
    processPaddleEvent(pool, {
      eventId: 'evt_missing_timestamp',
      eventType: 'subscription.updated',
      data: { id: 'sub_1', status: 'active', currentBillingPeriod: { endsAt: '2027-01-01T00:00:00Z' } }
    }),
    { message: 'invalid_paddle_event_timestamp' }
  );
  await assert.rejects(
    processPaddleEvent(pool, {
      eventId: 'evt_invalid_timestamp',
      eventType: 'subscription.updated',
      occurredAt: 'not-a-timestamp',
      data: { id: 'sub_1', status: 'active', currentBillingPeriod: { endsAt: '2027-01-01T00:00:00Z' } }
    }),
    { message: 'invalid_paddle_event_timestamp' }
  );
  assert.equal(connectCalls, 0);
});

test('subscription updates compare source timestamps and do not bypass ordering when missing', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes('INSERT INTO paddle_webhook_events')) return { rowCount: 1, rows: [{ event_id: 'evt_ordered' }] };
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  await processPaddleEvent({ async connect() { return client; } }, {
    eventId: 'evt_ordered',
    eventType: 'subscription.updated',
    occurredAt: '2026-10-24T20:00:00Z',
    data: {
      id: 'sub_ordered',
      status: 'active',
      currentBillingPeriod: { endsAt: '2027-01-01T00:00:00Z' },
      items: []
    }
  });
  const update = queries.find(query => query.sql.includes('paddle_subscription_updated_at = COALESCE'));
  assert.ok(update, 'expected subscription lifecycle update');
  assert.match(update.sql, /paddle_subscription_updated_at IS NULL OR \$8::timestamptz >= paddle_subscription_updated_at/);
  assert.doesNotMatch(update.sql, /\$8::timestamptz IS NULL/);
  assert.equal(update.params[7], '2026-10-24T20:00:00Z');
});

test('grants lifetime Premium only for a verified matching transaction price', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalPriceId = process.env.PADDLE_PRICE_ID_LIFETIME;
  process.env.PADDLE_PRICE_ID_LIFETIME = 'pri_lifetime_test';
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes('INSERT INTO paddle_webhook_events')) return { rowCount: 1, rows: [{ event_id: 'evt_lifetime' }] };
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  try {
    const pool = { async connect() { return client; } };
    const result = await processPaddleEvent(pool, {
      eventId: 'evt_lifetime',
      eventType: 'transaction.completed',
      data: {
        customData: { userId: '00000000-0000-4000-8000-000000000001', plan: 'lifetime' },
        items: [{ price: { id: 'pri_lifetime_test' } }]
      }
    });
    assert.equal(result.handled, true);
    const update = queries.find(query => query.sql.includes('premium_lifetime = TRUE'));
    assert.ok(update, 'expected the lifetime entitlement update');
    assert.equal(update.params[2], 'pri_lifetime_test');
  } finally {
    if (originalPriceId === undefined) delete process.env.PADDLE_PRICE_ID_LIFETIME;
    else process.env.PADDLE_PRICE_ID_LIFETIME = originalPriceId;
  }
});

test('does not grant lifetime Premium when the transaction price does not match configuration', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalPriceId = process.env.PADDLE_PRICE_ID_LIFETIME;
  process.env.PADDLE_PRICE_ID_LIFETIME = 'pri_expected';
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes('INSERT INTO paddle_webhook_events')) return { rowCount: 1, rows: [{ event_id: 'evt_wrong_price' }] };
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  try {
    const pool = { async connect() { return client; } };
    await processPaddleEvent(pool, {
      eventId: 'evt_wrong_price',
      eventType: 'transaction.completed',
      data: {
        customData: { userId: '00000000-0000-4000-8000-000000000001', plan: 'lifetime' },
        items: [{ price: { id: 'pri_unexpected' } }]
      }
    });
    assert.equal(queries.some(query => query.sql.includes('premium_lifetime = TRUE')), false);
  } finally {
    if (originalPriceId === undefined) delete process.env.PADDLE_PRICE_ID_LIFETIME;
    else process.env.PADDLE_PRICE_ID_LIFETIME = originalPriceId;
  }
});
