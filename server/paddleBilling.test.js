import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizePaddleEvent, isPaddleSubscriptionEntitled, isPremiumEntitlementActive, isPremiumCheckoutBlocked } from './paddleBilling.js';
import './financialModerationEvidence.integration.test.js';

test('normalizes Paddle webhook snake_case and SDK camelCase envelopes', () => {
  assert.deepEqual(normalizePaddleEvent({ event_id: 'evt_1', event_type: 'subscription.updated', data: {} }), {
    eventId: 'evt_1', eventType: 'subscription.updated', data: {}, occurredAt: null
  });
  assert.equal(normalizePaddleEvent({ eventId: 'evt_2', eventType: 'transaction.completed', data: {} }).eventId, 'evt_2');
  assert.equal(normalizePaddleEvent({ event_type: 'subscription.updated' }), null);
});


test('active Premium and corrupt entitlement data block duplicate checkout', () => {
  const now = Date.parse('2026-10-30T18:00:00Z');
  assert.equal(isPremiumEntitlementActive({ premium_lifetime: true }, now), true);
  assert.equal(isPremiumEntitlementActive({ premium_until: new Date('2026-11-01T00:00:00Z') }, now), true);
  assert.equal(isPremiumEntitlementActive({ premium_until: '2026-11-01T00:00:00Z' }, now), true);
  assert.equal(isPremiumEntitlementActive({ premium_until: '2026-10-01T00:00:00Z' }, now), false);
  assert.equal(isPremiumEntitlementActive({ premium_until: null }, now), false);
  assert.equal(isPremiumEntitlementActive({ premium_until: 'invalid-date' }, now), true);
  assert.equal(isPremiumEntitlementActive(null, now), true, 'missing user context must fail closed');
});

test('checkout stays blocked while a non-terminal Paddle subscription is unresolved', () => {
  const now = Date.parse('2026-10-30T18:00:00Z');
  assert.equal(isPremiumCheckoutBlocked({ premium_until: null, paddle_subscription_id: 'sub_pending', paddle_subscription_status: 'past_due' }, now), true);
  assert.equal(isPremiumCheckoutBlocked({ premium_until: null, paddle_subscription_id: 'sub_paused', paddle_subscription_status: 'paused' }, now), true);
  assert.equal(isPremiumCheckoutBlocked({ premium_until: null, paddle_subscription_id: 'sub_canceled', paddle_subscription_status: 'canceled' }, now), false);
  assert.equal(isPremiumCheckoutBlocked({ premium_until: null, paddle_subscription_id: 'sub_completed', paddle_subscription_status: 'completed' }, now), false);
  assert.equal(isPremiumCheckoutBlocked({ premium_until: null, paddle_subscription_id: null }, now), false);
  assert.equal(isPremiumCheckoutBlocked({ premium_until: null, paddle_subscription_id: null, paddle_subscription_status: 'active' }, now), true,
    'a non-terminal subscription status without its provider ID must fail closed');
  assert.equal(isPremiumCheckoutBlocked({ premium_until: null, paddle_subscription_id: null, paddle_subscription_status: 'past_due' }, now), true);
  assert.equal(isPremiumCheckoutBlocked({ premium_until: null, paddle_subscription_id: null, paddle_subscription_status: 'canceled' }, now), false);
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



test('malformed subscription lifecycle events are acknowledged without entitlement updates', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(String(sql));
      if (String(sql).includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: 'evt_malformed_lifecycle' }] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {}
  };
  const pool = { async connect() { return client; } };
  const malformedEvents = [
    {
      eventId: 'evt_missing_timestamp',
      eventType: 'subscription.updated',
      data: { id: 'sub_valid123', status: 'active', currentBillingPeriod: { endsAt: '2027-01-01T00:00:00Z' } }
    },
    {
      eventId: 'evt_invalid_timestamp',
      eventType: 'subscription.updated',
      occurredAt: 'not-a-timestamp',
      data: { id: 'sub_valid123', status: 'active', currentBillingPeriod: { endsAt: '2027-01-01T00:00:00Z' } }
    },
    {
      eventId: 'evt_missing_subscription_id',
      eventType: 'subscription.updated',
      occurredAt: '2026-10-24T20:00:00Z',
      data: { status: 'active', currentBillingPeriod: { endsAt: '2027-01-01T00:00:00Z' } }
    },
    {
      eventId: 'evt_malformed_subscription_id',
      eventType: 'subscription.updated',
      occurredAt: '2026-10-24T20:00:00Z',
      data: { id: 'txn_not_a_subscription', status: 'active', currentBillingPeriod: { endsAt: '2027-01-01T00:00:00Z' } }
    }
  ];

  for (const event of malformedEvents) {
    assert.deepEqual(await processPaddleEvent(pool, event), { duplicate: false, handled: true });
  }
  assert.equal(queries.filter(sql => sql.includes('INSERT INTO paddle_webhook_events')).length, 4);
  assert.equal(queries.some(sql => sql.includes('UPDATE users')), false);
  assert.equal(queries.filter(sql => sql === 'COMMIT').length, 4);
  assert.equal(queries.some(sql => sql === 'ROLLBACK'), false);
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
  assert.match(update.sql, /paddle_subscription_updated_at IS NULL/);
  assert.match(update.sql, /\$8::timestamptz > paddle_subscription_updated_at/);
  assert.match(update.sql, /\$8::timestamptz = paddle_subscription_updated_at/);
  assert.match(update.sql, /\$10::boolean OR/);
  assert.doesNotMatch(update.sql, /\$8::timestamptz IS NULL/);
  assert.match(update.sql, /other\.paddle_subscription_id = \$3 AND other\.id <> users\.id/);
  assert.match(update.sql, /other\.paddle_customer_id = \$2 AND other\.id <> users\.id/);
  assert.match(update.sql, /paddle_subscription_id IS NULL/);
  assert.match(update.sql, /\$9::boolean AND \(/, 'only subscription.created may attach a new subscription ID');
  assert.match(update.sql, /NOT \$9::boolean AND paddle_subscription_id = \$3/,
    'subscription.updated/canceled must match the already-owned subscription ID');
  assert.match(update.sql, /lower\(paddle_subscription_status\) IN \('canceled', 'completed'\)/);
  assert.equal(update.params[8], false, 'ordinary updates must not replace an established subscription ID');
  assert.equal(update.params[9], false, 'ordinary updates must not win equal-timestamp ties against a cancellation');
  assert.match(update.sql, /paddle_customer_id IS NULL OR paddle_customer_id = \$2/);
  assert.match(update.sql, /premium_lifetime IS NOT TRUE/, 'subscription webhooks must not overwrite lifetime Premium');
  assert.match(update.sql, /users\.status = 'active'/, 'subscription webhooks must not revive deleted accounts');
  assert.equal(update.params[7], '2026-10-24T20:00:00Z');
});


test('subscription.updated does not extend access when supplied custom_data owner is malformed', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalPriceId = process.env.PADDLE_PRICE_ID_1MONTH;
  process.env.PADDLE_PRICE_ID_1MONTH = 'pri_monthsubscriptionidentity';
  const existingOwner = '00000000-0000-4000-8000-000000000087';
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const statement = String(sql);
      calls.push({ statement, params });
      if (statement.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: params[0] }] };
      }
      if (statement.includes('SELECT id FROM users WHERE paddle_subscription_id')) {
        return { rowCount: 1, rows: [{ id: existingOwner }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  try {
    await processPaddleEvent({ async connect() { return client; } }, {
      eventId: 'evt_subscription_bad_owner',
      eventType: 'subscription.updated',
      occurredAt: '2026-11-04T12:30:00Z',
      data: {
        id: 'sub_subscriptionidentity123',
        status: 'active',
        customer_id: 'ctm_subscriptionidentity123',
        current_billing_period: { ends_at: '2027-01-01T00:00:00Z' },
        items: [{ price: { id: 'pri_monthsubscriptionidentity' } }],
        custom_data: { userId: 'not-a-vow-user-id', plan: '1month' }
      }
    });
    assert.equal(calls.some(call => call.statement.includes('UPDATE users SET')), false,
      'malformed custom_data must not fall back to the retained subscription owner for an access extension');
    const conflict = calls.find(call => call.statement.includes('INSERT INTO paddle_adjustment_reconciliation_cases'));
    assert.ok(conflict);
    assert.equal(conflict.params[2], null);
  } finally {
    if (originalPriceId === undefined) delete process.env.PADDLE_PRICE_ID_1MONTH;
    else process.env.PADDLE_PRICE_ID_1MONTH = originalPriceId;
  }
});

test('subscription.updated can still revoke access on past_due when owner metadata conflicts', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalPriceId = process.env.PADDLE_PRICE_ID_1MONTH;
  process.env.PADDLE_PRICE_ID_1MONTH = 'pri_monthsubscriptionpastdue';
  const existingOwner = '00000000-0000-4000-8000-000000000088';
  const conflictingOwner = '00000000-0000-4000-8000-000000000089';
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const statement = String(sql);
      calls.push({ statement, params });
      if (statement.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: params[0] }] };
      }
      if (statement.includes('SELECT id FROM users WHERE paddle_subscription_id')) {
        return { rowCount: 1, rows: [{ id: existingOwner }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  try {
    await processPaddleEvent({ async connect() { return client; } }, {
      eventId: 'evt_subscription_past_due_conflict',
      eventType: 'subscription.updated',
      occurredAt: '2026-11-04T12:35:00Z',
      data: {
        id: 'sub_subscriptionpastdue123',
        status: 'past_due',
        customer_id: 'ctm_subscriptionpastdue123',
        current_billing_period: { ends_at: '2027-01-01T00:00:00Z' },
        items: [{ price: { id: 'pri_monthsubscriptionpastdue' } }],
        custom_data: { userId: conflictingOwner, plan: '1month' }
      }
    });
    const update = calls.find(call => call.statement.includes('UPDATE users SET'));
    assert.ok(update, 'a non-entitling past_due event must still revoke the retained owner');
    assert.equal(update.params[0], null,
      'the update must resolve by the already-owned subscription ID, not the conflicting custom_data owner');
    assert.equal(update.params[1], null,
      'a conflicted customer ID must not be attached to the retained subscription owner');
    assert.equal(update.params[4], null,
      'a conflicted price ID must not overwrite the retained subscription price snapshot');
    assert.ok(calls.some(call => call.statement.includes('INSERT INTO paddle_adjustment_reconciliation_cases')));
  } finally {
    if (originalPriceId === undefined) delete process.env.PADDLE_PRICE_ID_1MONTH;
    else process.env.PADDLE_PRICE_ID_1MONTH = originalPriceId;
  }
});


test('subscription.canceled wins an equal-timestamp lifecycle ordering tie', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const queries = [];
  const client = {
    async query(sql, params) {
      const statement = String(sql);
      queries.push({ statement, params });
      if (statement.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: 'evt_tied_cancellation' }] };
      }
      if (statement.includes('SELECT id FROM users WHERE paddle_subscription_id')) {
        return { rowCount: 1, rows: [{ id: '00000000-0000-4000-8000-000000000001' }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };

  await processPaddleEvent({ async connect() { return client; } }, {
    eventId: 'evt_tied_cancellation',
    eventType: 'subscription.canceled',
    occurredAt: '2026-10-24T20:00:00Z',
    data: { id: 'sub_tied123', status: 'canceled' }
  });

  const update = queries.find(query => query.statement.includes('paddle_subscription_updated_at = COALESCE'));
  assert.ok(update, 'expected the cancellation lifecycle update');
  assert.equal(update.params[3], 'canceled');
  assert.equal(update.params[8], false, 'cancellation does not claim a newly-created subscription');
  assert.equal(update.params[9], true, 'cancellation must be allowed to win an equal-timestamp tie');
});

test('subscription lifecycle only grants Premium for explicitly configured Vow recurring prices', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalOneMonth = process.env.PADDLE_PRICE_ID_1MONTH;
  const originalThreeMonths = process.env.PADDLE_PRICE_ID_3MONTHS;
  process.env.PADDLE_PRICE_ID_1MONTH = 'pri_vowmonthly';
  process.env.PADDLE_PRICE_ID_3MONTHS = 'pri_vowquarterly';

  async function runSubscription(priceId, eventId) {
    const queries = [];
    const client = {
      async query(sql, params) {
        queries.push({ sql: String(sql), params });
        if (String(sql).includes('INSERT INTO paddle_webhook_events')) return { rowCount: 1, rows: [{ event_id: eventId }] };
        return { rowCount: 1, rows: [] };
      },
      release() {}
    };
    await processPaddleEvent({ async connect() { return client; } }, {
      eventId,
      eventType: 'subscription.updated',
      occurredAt: '2026-10-25T20:00:00Z',
      data: {
        id: 'sub_' + eventId.replace(/[^A-Za-z0-9]/g, ''),
        status: 'active',
        currentBillingPeriod: { endsAt: '2027-01-01T00:00:00Z' },
        items: [{ price: { id: priceId } }]
      }
    });
    return queries.find(query => query.sql.includes('premium_until = CASE'));
  }

  try {
    const approvedUpdate = await runSubscription('pri_vowmonthly', 'evt_vow_price');
    assert.ok(approvedUpdate, 'expected the approved subscription update');
    assert.equal(approvedUpdate.params[5], true, 'configured Vow recurring price should grant active Premium');

    const unrelatedUpdate = await runSubscription('pri_other_product', 'evt_other_price');
    assert.ok(unrelatedUpdate, 'expected the unrelated subscription update');
    assert.equal(unrelatedUpdate.params[5], false, 'an unrelated Paddle price must not grant Premium');
    assert.equal(unrelatedUpdate.params[6], null, 'an unrelated Paddle price must not set premium_until');

    // Missing server configuration must fail closed even when the event carries
    // a price ID that would otherwise be accepted by the configured catalogue.
    delete process.env.PADDLE_PRICE_ID_1MONTH;
    delete process.env.PADDLE_PRICE_ID_3MONTHS;
    const unconfiguredUpdate = await runSubscription('pri_vowmonthly', 'evt_unconfigured_price');
    assert.ok(unconfiguredUpdate, 'expected the unconfigured subscription update');
    assert.equal(unconfiguredUpdate.params[5], false, 'missing Vow price configuration must not grant Premium');
    assert.equal(unconfiguredUpdate.params[6], null, 'missing Vow price configuration must not set premium_until');
  } finally {
    if (originalOneMonth === undefined) delete process.env.PADDLE_PRICE_ID_1MONTH;
    else process.env.PADDLE_PRICE_ID_1MONTH = originalOneMonth;
    if (originalThreeMonths === undefined) delete process.env.PADDLE_PRICE_ID_3MONTHS;
    else process.env.PADDLE_PRICE_ID_3MONTHS = originalThreeMonths;
  }
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
        id: 'txn_0123456789abcdef01234567',
        customData: { userId: '00000000-0000-4000-8000-000000000001', plan: 'lifetime', checkoutAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        items: [{ price: { id: 'pri_lifetime_test' } }]
      }
    });
    assert.equal(result.handled, true);
    const update = queries.find(query => query.sql.includes('premium_lifetime = TRUE'));
    assert.ok(update, 'expected the lifetime entitlement update');
    assert.equal(update.params[2], 'pri_lifetime_test');
    assert.match(update.sql, /users\.status = 'active'/, 'lifetime transactions must not revive deleted accounts');
    assert.match(update.sql, /paddle_subscription_id IS NULL OR lower\(paddle_subscription_status\) IN \('canceled', 'completed'\)/,
      'lifetime Premium must not detach an active subscription before cancellation/reconciliation');
    const attemptClaim = queries.find(query =>
      query.sql.includes('SET transaction_id = $1, status = \'completed\'') &&
      query.sql.includes('status IN (\'creating\', \'pending\', \'completed\', \'reconciliation_required\')')
    );
    assert.ok(attemptClaim, 'expected the verified transaction to claim a durable checkout attempt');
    assert.deepEqual(attemptClaim.params, [
      'txn_0123456789abcdef01234567',
      '00000000-0000-4000-8000-000000000001',
      'lifetime',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    ]);
    const attemptUpdate = queries.find(query =>
      query.sql.includes('WHERE transaction_id = $1 AND user_id = $3')
    );
    assert.ok(attemptUpdate, 'expected the completed lifetime checkout attempt to be settled');
    assert.deepEqual(attemptUpdate.params, [
      'txn_0123456789abcdef01234567',
      'linked',
      '00000000-0000-4000-8000-000000000001',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    ]);
  } finally {
    if (originalPriceId === undefined) delete process.env.PADDLE_PRICE_ID_LIFETIME;
    else process.env.PADDLE_PRICE_ID_LIFETIME = originalPriceId;
  }
});

test('does not grant lifetime Premium when no matching durable checkout attempt exists', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalPriceId = process.env.PADDLE_PRICE_ID_LIFETIME;
  process.env.PADDLE_PRICE_ID_LIFETIME = 'pri_lifetime_test';
  const queries = [];
  const client = {
    async query(sql, params) {
      const query = { sql: String(sql), params };
      queries.push(query);
      if (query.sql.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: 'evt_unowned_lifetime' }] };
      }
      if (query.sql.includes('SET transaction_id = $1, status = \'completed\'')) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  try {
    await processPaddleEvent({ async connect() { return client; } }, {
      eventId: 'evt_unowned_lifetime',
      eventType: 'transaction.completed',
      data: {
        id: 'txn_0123456789abcdef01234567',
        customData: { userId: '00000000-0000-4000-8000-000000000001', plan: 'lifetime' },
        items: [{ price: { id: 'pri_lifetime_test' } }]
      }
    });
    assert.equal(queries.some(query => query.sql.includes('premium_lifetime = TRUE')), false,
      'matching price and custom_data must not grant Premium without a server-created attempt');
    assert.equal(queries.some(query => query.sql.includes('UPDATE users')), false);
    assert.equal(queries.some(query => query.sql.includes('WHERE transaction_id = $1 AND user_id = $3')), false);
  } finally {
    if (originalPriceId === undefined) delete process.env.PADDLE_PRICE_ID_LIFETIME;
    else process.env.PADDLE_PRICE_ID_LIFETIME = originalPriceId;
  }
});

test('recurring transaction completion cannot bind Paddle identities without its checkout attempt', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalPriceId = process.env.PADDLE_PRICE_ID_1MONTH;
  process.env.PADDLE_PRICE_ID_1MONTH = 'pri_month_test';
  const queries = [];
  const client = {
    async query(sql, params) {
      const query = { sql: String(sql), params };
      queries.push(query);
      if (query.sql.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: 'evt_unowned_recurring' }] };
      }
      if (query.sql.includes('SET transaction_id = $1, status = \'completed\'')) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  try {
    await processPaddleEvent({ async connect() { return client; } }, {
      eventId: 'evt_unowned_recurring',
      eventType: 'transaction.completed',
      data: {
        id: 'txn_0123456789abcdef01234567',
        subscriptionId: 'sub_0123456789abcdef01234567',
        customerId: 'ctm_0123456789abcdef01234567',
        customData: { userId: '00000000-0000-4000-8000-000000000001', plan: '1month', checkoutAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        items: [{ price: { id: 'pri_month_test' } }]
      }
    });
    assert.equal(queries.some(query => query.sql.includes('UPDATE users')), false,
      'a recurring transaction without a server-created attempt must not attach customer or subscription IDs');
    assert.equal(queries.some(query => query.sql.includes('WHERE transaction_id = $1 AND user_id = $3')), false);
  } finally {
    if (originalPriceId === undefined) delete process.env.PADDLE_PRICE_ID_1MONTH;
    else process.env.PADDLE_PRICE_ID_1MONTH = originalPriceId;
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
        id: 'txn_wrongprice',
        customData: {
          userId: '00000000-0000-4000-8000-000000000001',
          plan: 'lifetime',
          checkoutAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        },
        items: [{ price: { id: 'pri_unexpected' } }]
      }
    });
    assert.equal(queries.some(query => query.sql.includes('premium_lifetime = TRUE')), false);
    assert.equal(
      queries.some(query => query.sql.includes('UPDATE users')),
      false,
      'a transaction with an unexpected price must not bind Paddle identities'
    );
    assert.equal(
      queries.some(query => query.sql.includes("SET transaction_id = $1, status = 'completed'")),
      false,
      'a transaction with an unexpected price must not complete a checkout attempt'
    );
    assert.equal(
      queries.some(query => query.sql.includes("SET status = 'reconciliation_required'")),
      true,
      'the mismatched transaction must remain visible for manual reconciliation'
    );
  } finally {
    if (originalPriceId === undefined) delete process.env.PADDLE_PRICE_ID_LIFETIME;
    else process.env.PADDLE_PRICE_ID_LIFETIME = originalPriceId;
  }
});


test('ambiguous configured price IDs cannot link a lifetime checkout', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalLifetimePriceId = process.env.PADDLE_PRICE_ID_LIFETIME;
  const originalMonthlyPriceId = process.env.PADDLE_PRICE_ID_1MONTH;
  process.env.PADDLE_PRICE_ID_LIFETIME = 'pri_ambiguous';
  process.env.PADDLE_PRICE_ID_1MONTH = 'pri_ambiguous';
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: 'evt_ambiguousplan' }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };

  try {
    const result = await processPaddleEvent({ async connect() { return client; } }, {
      eventId: 'evt_ambiguousplan',
      eventType: 'transaction.completed',
      data: {
        id: 'txn_ambiguousplan',
        customData: {
          userId: '00000000-0000-4000-8000-000000000001',
          plan: 'lifetime',
          checkoutAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        },
        items: [{ price: { id: 'pri_ambiguous' } }]
      }
    });

    assert.equal(result.handled, true);
    assert.equal(queries.some(query => query.sql.includes("SET transaction_id = $1, status = 'completed'")), false,
      'a price ID configured for multiple plans must not claim a checkout attempt');
    assert.equal(queries.some(query => query.sql.includes('premium_lifetime = TRUE')), false,
      'ambiguous price configuration must never grant lifetime Premium');
    assert.equal(queries.some(query => query.sql.includes('INSERT INTO paddle_lifetime_entitlements')), false);
    const transactionEvidence = queries.find(query => query.sql.includes('INSERT INTO paddle_transaction_events'));
    assert.ok(transactionEvidence, 'retain the signed provider transaction for reconciliation');
    assert.equal(transactionEvidence.params[3], null,
      'an ambiguous provider price must not be assigned a guessed plan');
    const reconciliation = queries.find(query => query.sql.includes("SET status = 'reconciliation_required'"));
    assert.ok(reconciliation, 'the exact checkout attempt must remain available for manual reconciliation');
  } finally {
    if (originalLifetimePriceId === undefined) delete process.env.PADDLE_PRICE_ID_LIFETIME;
    else process.env.PADDLE_PRICE_ID_LIFETIME = originalLifetimePriceId;
    if (originalMonthlyPriceId === undefined) delete process.env.PADDLE_PRICE_ID_1MONTH;
    else process.env.PADDLE_PRICE_ID_1MONTH = originalMonthlyPriceId;
  }
});

test('malformed completed transaction IDs are acknowledged without database constraint retries', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalPriceId = process.env.PADDLE_PRICE_ID_LIFETIME;
  process.env.PADDLE_PRICE_ID_LIFETIME = 'pri_lifetime_test';
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: 'evt_malformed_transaction_id' }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };

  try {
    const result = await processPaddleEvent({ async connect() { return client; } }, {
      eventId: 'evt_malformed_transaction_id',
      eventType: 'transaction.completed',
      data: {
        id: 'not-a-transaction-id',
        customData: { userId: '00000000-0000-4000-8000-000000000001', plan: 'lifetime' },
        items: [{ price: { id: 'pri_lifetime_test' } }]
      }
    });

    assert.deepEqual(result, { duplicate: false, handled: true });
    assert.equal(queries.some(query => query.sql.includes('UPDATE paddle_checkout_attempts')), false);
    assert.equal(queries.some(query => query.sql.includes('UPDATE users')), false);
    assert.equal(queries.some(query => query.sql === 'COMMIT'), true);
    assert.equal(queries.some(query => query.sql === 'ROLLBACK'), false);
  } finally {
    if (originalPriceId === undefined) delete process.env.PADDLE_PRICE_ID_LIFETIME;
    else process.env.PADDLE_PRICE_ID_LIFETIME = originalPriceId;
  }
});

test('customer webhook cannot replace an account customer ID once established', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes('INSERT INTO paddle_webhook_events')) return { rowCount: 1, rows: [{ event_id: 'evt_customer_identity' }] };
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  await processPaddleEvent({ async connect() { return client; } }, {
    eventId: 'evt_customer_identity',
    eventType: 'customer.updated',
    data: {
      id: 'ctm_newidentity',
      customData: { userId: '00000000-0000-4000-8000-000000000001' },
      email: 'person@example.com'
    }
  });
  const update = queries.find(query => query.sql.includes('lower(email) = lower($3)'));
  assert.ok(update, 'expected customer identity update');
  assert.match(update.sql, /paddle_customer_id IS NULL OR paddle_customer_id = \$2/);
  assert.match(update.sql, /users\.status = 'active'/, 'customer webhooks must not mutate deleted accounts');
});


test('conflicting customer webhook identity is retained for moderator reconciliation', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const userId = '00000000-0000-4000-8000-000000000001';
  const attemptId = '00000000-0000-4000-8000-000000000002';
  const queries = [];
  const client = {
    async query(sql, params = []) {
      const statement = String(sql);
      queries.push({ statement, params });
      if (statement.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: params[0] }] };
      }
      if (statement.includes('UPDATE users SET paddle_customer_id')) {
        return { rowCount: 0, rows: [] };
      }
      if (statement.includes('customer_owned_by_other')) {
        return { rowCount: 1, rows: [{ customer_owned_by_other: true, account_customer_mismatch: false }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  const result = await processPaddleEvent({ async connect() { return client; } }, {
    eventId: 'evt_customer_conflict',
    eventType: 'customer.updated',
    data: {
      id: 'ctm_conflictingidentity',
      email: 'person@example.com',
      customData: { userId, plan: 'lifetime', checkoutAttemptId: attemptId }
    }
  });
  assert.deepEqual(result, {
    duplicate: false, handled: true, reconciliationRequired: true
  });
  const caseInsert = queries.find(query =>
    query.statement.includes('INSERT INTO paddle_adjustment_reconciliation_cases')
  );
  assert.ok(caseInsert, 'a failed provider customer identity claim must not be silently acknowledged');
  assert.equal(caseInsert.params[1], 'provider_identity_conflict');
  assert.equal(caseInsert.params[3], null,
    'customer lifecycle conflicts do not fabricate a Paddle adjustment ID');
  assert.equal(caseInsert.params[4], userId);
  assert.equal(caseInsert.params[5], 'lifetime');
  assert.ok(queries.some(query => query.statement.includes('ROLLBACK TO SAVEPOINT paddle_event_effects')),
    'the conflicting customer assignment must be rolled back before the durable reconciliation case is inserted');
});

test('duplicate Paddle webhook IDs commit without replaying entitlement updates', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {}
  };

  const result = await processPaddleEvent({ async connect() { return client; } }, {
    eventId: 'evt_already_processed',
    eventType: 'transaction.completed',
    data: {
      customData: { userId: '00000000-0000-4000-8000-000000000001', plan: 'lifetime' },
      items: [{ price: { id: 'pri_lifetime_test' } }]
    }
  });

  assert.deepEqual(result, { duplicate: true, handled: false });
  assert.equal(queries.filter(query => query.sql.includes('INSERT INTO paddle_webhook_events')).length, 1);
  assert.equal(queries.some(query => query.sql.includes('UPDATE users')), false);
  assert.equal(queries.some(query => query.sql === 'COMMIT'), true);
  assert.equal(queries.some(query => query.sql === 'ROLLBACK'), false);
});

test('malformed Paddle custom user IDs are ignored instead of poisoning webhook retries', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalPriceId = process.env.PADDLE_PRICE_ID_LIFETIME;
  process.env.PADDLE_PRICE_ID_LIFETIME = 'pri_lifetime_test';
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes('INSERT INTO paddle_webhook_events')) return { rowCount: 1, rows: [{ event_id: 'evt_bad_custom_user_id' }] };
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };

  try {
    const result = await processPaddleEvent({ async connect() { return client; } }, {
      eventId: 'evt_bad_custom_user_id',
      eventType: 'transaction.completed',
      data: {
        customData: { userId: 'not-a-uuid', plan: 'lifetime' },
        items: [{ price: { id: 'pri_lifetime_test' } }]
      }
    });

    assert.equal(result.handled, true);
    assert.equal(queries.some(query => query.sql.includes('UPDATE users')), false);
    assert.equal(queries.some(query => query.sql.includes('UPDATE paddle_checkout_attempts')), false);
    assert.equal(queries.some(query => query.sql === 'COMMIT'), true);
  } finally {
    if (originalPriceId === undefined) delete process.env.PADDLE_PRICE_ID_LIFETIME;
    else process.env.PADDLE_PRICE_ID_LIFETIME = originalPriceId;
  }
});



test('a new subscription may replace a terminal prior subscription but not an active one', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalPriceId = process.env.PADDLE_PRICE_ID_1MONTH;
  process.env.PADDLE_PRICE_ID_1MONTH = 'pri_month_test';

  async function capture(eventType, eventId) {
    const queries = [];
    const client = {
      async query(sql, params) {
        queries.push({ sql: String(sql), params });
        if (String(sql).includes('INSERT INTO paddle_webhook_events')) return { rowCount: 1, rows: [{ event_id: eventId }] };
        return { rowCount: 1, rows: [] };
      },
      release() {}
    };
    await processPaddleEvent({ async connect() { return client; } }, {
      eventId,
      eventType,
      occurredAt: '2026-10-30T18:00:00Z',
      data: {
        id: 'sub_' + eventId.replace(/[^A-Za-z0-9]/g, ''),
        status: 'active',
        customerId: 'ctm_existing',
        customData: { userId: '00000000-0000-4000-8000-000000000001', plan: '1month', checkoutAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        transaction_id: 'txn_0123456789abcdef01234567',
        currentBillingPeriod: { endsAt: '2027-01-30T18:00:00Z' },
        items: [{ price: { id: 'pri_month_test' } }]
      }
    });
    return queries.find(query => query.sql.includes('paddle_subscription_updated_at = COALESCE'));
  }

  try {
    const created = await capture('subscription.created', 'evt_new_subscription');
    assert.ok(created, 'expected the new subscription lifecycle update');
    assert.equal(created.params[8], true, 'subscription.created may replace an already terminal subscription');
    assert.match(created.sql, /paddle_subscription_id IS DISTINCT FROM \$3\s+AND lower\(paddle_subscription_status\) IN \('canceled', 'completed'\)/,
      'a terminal prior subscription may be replaced only by a different provider subscription ID');
    assert.match(created.sql, /paddle_subscription_id = \$3\s+AND COALESCE\(lower\(paddle_subscription_status\), ''\) NOT IN \('canceled', 'completed'\)/,
      'a same-ID created event may finish first-time linking, but must never resurrect a terminal subscription');
    assert.match(created.sql, /lower\(paddle_subscription_status\) IN \('canceled', 'completed'\)/);

    const updated = await capture('subscription.updated', 'evt_updated_subscription');
    assert.ok(updated, 'expected the ordinary subscription lifecycle update');
    assert.equal(updated.params[8], false, 'subscription.updated must not replace an established subscription ID');
  } finally {
    if (originalPriceId === undefined) delete process.env.PADDLE_PRICE_ID_1MONTH;
    else process.env.PADDLE_PRICE_ID_1MONTH = originalPriceId;
  }
});


test('Paddle customer portal sessions return only a trusted authenticated portal URL', async () => {
  const { createPaddleCustomerPortalSession } = await import('./paddleBilling.js');
  let request;
  const result = await createPaddleCustomerPortalSession({
    apiKey: 'sandbox_api_key',
    customerId: 'ctm_0123456789abcdef01234567',
    subscriptionId: 'sub_0123456789abcdef01234567',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        async json() {
          return { data: {
            customer_id: 'ctm_0123456789abcdef01234567',
            urls: {
              general: { overview: 'https://sandbox-customer-portal.paddle.com/session?token=secret' },
              subscriptions: [{
                id: 'sub_0123456789abcdef01234567',
                cancel_subscription: 'https://sandbox-customer-portal.paddle.com/session?token=secret&action=cancel',
                view_subscription: 'https://sandbox-customer-portal.paddle.com/session?token=secret&action=view'
              }]
            }
          } };
        }
      };
    }
  });
  assert.equal(request.url, 'https://sandbox-api.paddle.com/customers/ctm_0123456789abcdef01234567/portal-sessions');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['Paddle-Version'], '1');
  assert.deepEqual(JSON.parse(request.options.body), { subscription_ids: ['sub_0123456789abcdef01234567'] });
  assert.equal(result.url, 'https://sandbox-customer-portal.paddle.com/session?token=secret&action=view');
});

test('Paddle portal rejects mismatched customers and untrusted redirect URLs', async () => {
  const { createPaddleCustomerPortalSession } = await import('./paddleBilling.js');
  const makeFetch = payload => async () => ({
    ok: true,
    async json() { return payload; }
  });
  await assert.rejects(
    createPaddleCustomerPortalSession({
      apiKey: 'sandbox_api_key',
      customerId: 'ctm_0123456789abcdef01234567',
      fetchImpl: makeFetch({ data: {
        customer_id: 'ctm_another_customer',
        urls: { general: { overview: 'https://customer-portal.paddle.com/session' } }
      } })
    }),
    { message: 'paddle_portal_session_failed' }
  );
  for (const overview of [
    'https://attacker.example/steal-token',
    'https://sandbox-customer-portal.paddle.com.attacker.example/session',
    'https://customer-portal.paddle.com/session',
    'https://user@customer-portal.paddle.com/session',
    'https://customer-portal.paddle.com:444/session'
  ]) {
    await assert.rejects(
      createPaddleCustomerPortalSession({
        apiKey: 'sandbox_api_key',
        customerId: 'ctm_0123456789abcdef01234567',
        fetchImpl: makeFetch({ data: {
          customer_id: 'ctm_0123456789abcdef01234567',
          urls: { general: { overview } }
        } })
      }),
      { message: 'paddle_portal_url_invalid' }
    );
  }
});

test('Paddle subscription cancellation requires a confirmed immediate cancellation response', async () => {
  const { cancelPaddleSubscription } = await import('./paddleBilling.js');
  const requests = [];
  const result = await cancelPaddleSubscription({
    apiKey: 'sandbox_api_key',
    subscriptionId: 'sub_0123456789abcdef01234567',
    customerId: 'ctm_0123456789abcdef01234567',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        async json() {
          return {
            data: {
              id: 'sub_0123456789abcdef01234567',
              customer_id: 'ctm_0123456789abcdef01234567',
              status: options.method === 'GET' ? 'active' : 'canceled'
            }
          };
        }
      };
    }
  });
  assert.equal(requests.length, 2, 'ownership must be checked before cancellation');
  assert.equal(requests[0].url, 'https://sandbox-api.paddle.com/subscriptions/sub_0123456789abcdef01234567');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[1].url, 'https://sandbox-api.paddle.com/subscriptions/sub_0123456789abcdef01234567/cancel');
  assert.equal(requests[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[1].options.body), { effective_from: 'immediately' });
  assert.deepEqual(result, {
    subscriptionId: 'sub_0123456789abcdef01234567',
    status: 'canceled',
    customerId: 'ctm_0123456789abcdef01234567',
    updatedAt: null
  });

  await assert.rejects(
    cancelPaddleSubscription({
      apiKey: 'sandbox_api_key',
      subscriptionId: 'sub_0123456789abcdef01234567',
      customerId: 'ctm_0123456789abcdef01234567',
      fetchImpl: async () => ({
        ok: true,
        async json() { return { data: { id: 'sub_0123456789abcdef01234567', customer_id: 'ctm_0123456789abcdef01234567', status: 'active' } }; }
      })
    }),
    { message: 'paddle_subscription_cancel_unconfirmed' }
  );
  let cancellationPostCalls = 0;
  await assert.rejects(
    cancelPaddleSubscription({
      apiKey: 'sandbox_api_key',
      subscriptionId: 'sub_0123456789abcdef01234567',
      customerId: 'ctm_0123456789abcdef01234567',
      fetchImpl: async (_url, options) => {
        if (options.method === 'POST') cancellationPostCalls += 1;
        return {
          ok: true,
          async json() {
            return { data: { id: 'sub_0123456789abcdef01234567', customer_id: 'ctm_other_customer', status: 'active' } };
          }
        };
      }
    }),
    { message: 'paddle_subscription_ownership_unconfirmed' }
  );
  assert.equal(cancellationPostCalls, 0, 'a foreign subscription must never receive a cancellation request');
});

test('Paddle subscription cancellation rejects unsupported provider status without POST', async () => {
  const { cancelPaddleSubscription } = await import('./paddleBilling.js');
  const calls = [];
  await assert.rejects(
    cancelPaddleSubscription({
      apiKey: 'sandbox_api_key',
      subscriptionId: 'sub_0123456789abcdef01234567',
      customerId: 'ctm_0123456789abcdef01234567',
      fetchImpl: async (url, options) => {
        calls.push({ url, method: options.method });
        return {
          ok: true,
          async json() {
            return {
              data: {
                id: 'sub_0123456789abcdef01234567',
                customer_id: 'ctm_0123456789abcdef01234567',
                status: 'completed'
              }
            };
          }
        };
      }
    }),
    { message: 'paddle_subscription_status_unrecognized' }
  );
  assert.deepEqual(calls, [{
    url: 'https://sandbox-api.paddle.com/subscriptions/sub_0123456789abcdef01234567',
    method: 'GET'
  }], 'unknown provider status must never be treated as a confirmed cancellation or trigger an unverified POST');
});
test('Paddle portal and cancellation helpers reject live environment and malformed IDs before network access', async () => {
  const { createPaddleCustomerPortalSession, cancelPaddleSubscription } = await import('./paddleBilling.js');
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('unexpected_network_call'); };
  await assert.rejects(
    createPaddleCustomerPortalSession({
      apiKey: 'api_key',
      environment: 'production',
      customerId: 'ctm_0123456789abcdef01234567',
      fetchImpl
    }),
    { message: 'paddle_portal_not_configured' }
  );
  await assert.rejects(
    cancelPaddleSubscription({
      apiKey: 'api_key',
      environment: 'production',
      subscriptionId: 'sub_0123456789abcdef01234567',
      customerId: 'ctm_0123456789abcdef01234567',
      fetchImpl
    }),
    { message: 'paddle_cancellation_not_configured' }
  );
  await assert.rejects(
    cancelPaddleSubscription({
      apiKey: 'api_key',
      subscriptionId: 'not-a-subscription',
      customerId: 'ctm_0123456789abcdef01234567',
      fetchImpl
    }),
    { message: 'paddle_cancellation_not_configured' }
  );
  assert.equal(calls, 0);
});


test('Paddle checkout transaction lookup verifies user, plan, and immutable attempt ownership', async () => {
  const { getPaddleCheckoutTransaction } = await import('./paddleBilling.js');
  const result = await getPaddleCheckoutTransaction({
    apiKey: 'sandbox_api_key',
    transactionId: 'txn_0123456789abcdef01234567',
    expectedUserId: '00000000-0000-4000-8000-000000000001',
    expectedPlan: '3months',
    expectedAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://sandbox-api.paddle.com/transactions/txn_0123456789abcdef01234567');
      assert.equal(options.method, 'GET');
      return {
        ok: true,
        async json() {
          return { data: {
            id: 'txn_0123456789abcdef01234567',
            status: 'ready',
            custom_data: {
              userId: '00000000-0000-4000-8000-000000000001',
              plan: '3months',
              checkoutAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
            }
          } };
        }
      };
    }
  });
  assert.deepEqual(result, { id: 'txn_0123456789abcdef01234567', status: 'ready', origin: '', subscriptionId: null });
  await assert.rejects(
    getPaddleCheckoutTransaction({
      apiKey: 'sandbox_api_key',
      transactionId: 'txn_0123456789abcdef01234567',
      expectedUserId: '00000000-0000-4000-8000-000000000001',
      expectedPlan: '3months',
      expectedAttemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return { data: {
            id: 'txn_0123456789abcdef01234567',
            status: 'ready',
            custom_data: {
              userId: '00000000-0000-4000-8000-000000000001',
              plan: '3months',
              checkoutAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
            }
          } };
        }
      })
    }),
    { message: 'paddle_transaction_ownership_unconfirmed' }
  );
});

test('Paddle checkout cancellation cancels only owned draft or ready transactions', async () => {
  const { cancelPaddleCheckoutTransaction } = await import('./paddleBilling.js');
  const requests = [];
  const result = await cancelPaddleCheckoutTransaction({
    apiKey: 'sandbox_api_key',
    transactionId: 'txn_0123456789abcdef01234567',
    expectedUserId: '00000000-0000-4000-8000-000000000001',
    expectedPlan: '1month',
    expectedAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (options.method === 'GET') {
        return {
          ok: true,
          async json() {
            return { data: {
              id: 'txn_0123456789abcdef01234567',
              status: 'ready',
              custom_data: { userId: '00000000-0000-4000-8000-000000000001', plan: '1month', checkoutAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
            } };
          }
        };
      }
      return {
        ok: true,
        async json() {
          return { data: { id: 'txn_0123456789abcdef01234567', status: 'canceled' } };
        }
      };
    }
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(requests[1].options.body), { status: 'canceled' });
  assert.deepEqual(result, { id: 'txn_0123456789abcdef01234567', status: 'canceled' });

  const completed = await cancelPaddleCheckoutTransaction({
    apiKey: 'sandbox_api_key',
    transactionId: 'txn_0123456789abcdef01234567',
    expectedUserId: '00000000-0000-4000-8000-000000000001',
    expectedPlan: '1month',
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { data: {
          id: 'txn_0123456789abcdef01234567',
          status: 'completed',
          custom_data: { userId: '00000000-0000-4000-8000-000000000001', plan: '1month' }
        } };
      }
    })
  });
  assert.deepEqual(completed, {
    id: 'txn_0123456789abcdef01234567',
    status: 'completed',
    origin: '',
    subscriptionId: null
  });

  const subscriptionOriginRequests = [];
  const subscriptionOrigin = await cancelPaddleCheckoutTransaction({
    apiKey: 'sandbox_api_key',
    transactionId: 'txn_0123456789abcdef01234567',
    expectedUserId: '00000000-0000-4000-8000-000000000001',
    expectedPlan: '1month',
    fetchImpl: async (url, options) => {
      subscriptionOriginRequests.push(options.method);
      return {
        ok: true,
        async json() {
          return { data: {
            id: 'txn_0123456789abcdef01234567',
            status: 'ready',
            origin: 'subscription_charge',
            subscription_id: 'sub_0123456789abcdef01234567',
            custom_data: { userId: '00000000-0000-4000-8000-000000000001', plan: '1month' }
          } };
        }
      };
    }
  });
  assert.equal(subscriptionOrigin.status, 'subscription_transaction');
  assert.deepEqual(subscriptionOriginRequests, ['GET'], 'subscription-origin transactions must not be canceled through the transaction API');
});


test('verified recurring transaction completion is held until its subscription webhook links it', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalPriceId = process.env.PADDLE_PRICE_ID_1MONTH;
  process.env.PADDLE_PRICE_ID_1MONTH = 'pri_month_test';
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes('INSERT INTO paddle_webhook_events')) return { rowCount: 1, rows: [{ event_id: 'evt_month_transaction' }] };
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  try {
    await processPaddleEvent({ async connect() { return client; } }, {
      eventId: 'evt_month_transaction',
      eventType: 'transaction.completed',
      data: {
        id: 'txn_0123456789abcdef01234567',
        customData: { userId: '00000000-0000-4000-8000-000000000001', plan: '1month', checkoutAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        items: [{ price: { id: 'pri_month_test' } }]
      }
    });
    const attemptUpdate = queries.find(query =>
      query.sql.includes('WHERE transaction_id = $1 AND user_id = $3')
    );
    assert.ok(attemptUpdate, 'expected recurring checkout attempt to enter completed state');
    assert.deepEqual(attemptUpdate.params, [
      'txn_0123456789abcdef01234567',
      'completed',
      '00000000-0000-4000-8000-000000000001',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    ]);
    const userRowLockIndex = queries.findIndex(query =>
      query.sql.includes('SELECT id FROM users WHERE id = $1 FOR UPDATE')
    );
    const attemptClaimIndex = queries.findIndex(query =>
      query.sql.includes('UPDATE paddle_checkout_attempts') &&
      query.sql.includes('SET transaction_id = $1, status = \'completed\'')
    );
    assert.ok(userRowLockIndex >= 0, 'webhook must lock the account row before claiming its checkout attempt');
    assert.ok(attemptClaimIndex > userRowLockIndex,
      'webhook must follow the same user-then-attempt lock order as the checkout endpoint');
  } finally {
    if (originalPriceId === undefined) delete process.env.PADDLE_PRICE_ID_1MONTH;
    else process.env.PADDLE_PRICE_ID_1MONTH = originalPriceId;
  }
});

test('subscription.created without a Paddle customer ID cannot grant access and reconciles its attempt', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalPriceId = process.env.PADDLE_PRICE_ID_1MONTH;
  process.env.PADDLE_PRICE_ID_1MONTH = 'pri_month_test';
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: 'evt_subscription_without_customer' }] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {}
  };
  try {
    const result = await processPaddleEvent({ async connect() { return client; } }, {
      eventId: 'evt_subscription_without_customer',
      eventType: 'subscription.created',
      occurredAt: '2026-10-30T18:00:00Z',
      data: {
        id: 'sub_0123456789abcdef01234567',
        status: 'active',
        customData: {
          userId: '00000000-0000-4000-8000-000000000001',
          plan: '1month',
          checkoutAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        },
        transaction_id: 'txn_0123456789abcdef01234567',
        currentBillingPeriod: { endsAt: '2026-11-30T18:00:00Z' },
        items: [{ price: { id: 'pri_month_test' } }]
      }
    });
    assert.deepEqual(result, { duplicate: false, handled: true });
    assert.equal(queries.some(query => query.sql.includes('UPDATE users')), false);
    const reconciliation = queries.find(query => query.sql.includes("SET status = 'reconciliation_required'"));
    assert.ok(reconciliation, 'a subscription missing its required customer identity must be reviewed');
    assert.deepEqual(reconciliation.params, [
      '00000000-0000-4000-8000-000000000001',
      '1month',
      'txn_0123456789abcdef01234567',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    ]);
    assert.equal(queries.some(query => query.sql === 'COMMIT'), true);
  } finally {
    if (originalPriceId === undefined) delete process.env.PADDLE_PRICE_ID_1MONTH;
    else process.env.PADDLE_PRICE_ID_1MONTH = originalPriceId;
  }
});

test('subscription.created cannot grant Premium without a matching server checkout attempt', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalPriceId = process.env.PADDLE_PRICE_ID_1MONTH;
  process.env.PADDLE_PRICE_ID_1MONTH = 'pri_month_test';
  const queries = [];
  const client = {
    async query(sql, params) {
      const query = { sql: String(sql), params };
      queries.push(query);
      if (query.sql.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: 'evt_unowned_subscription' }] };
      }
      if (query.sql.includes('UPDATE paddle_checkout_attempts')) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  try {
    await processPaddleEvent({ async connect() { return client; } }, {
      eventId: 'evt_unowned_subscription',
      eventType: 'subscription.created',
      occurredAt: '2026-10-30T18:00:00Z',
      data: {
        id: 'sub_0123456789abcdef01234567',
        status: 'active',
        customerId: 'ctm_0123456789abcdef01234567',
        customData: { userId: '00000000-0000-4000-8000-000000000001', plan: '1month' },
        currentBillingPeriod: { endsAt: '2026-11-30T18:00:00Z' },
        items: [{ price: { id: 'pri_month_test' } }]
      }
    });
    assert.equal(queries.some(query => query.sql.includes('paddle_subscription_updated_at = COALESCE')), false,
      'a subscription without a matching checkout attempt must not attach or grant Premium');
    assert.equal(queries.some(query => query.sql.includes('UPDATE users')), false);
  } finally {
    if (originalPriceId === undefined) delete process.env.PADDLE_PRICE_ID_1MONTH;
    else process.env.PADDLE_PRICE_ID_1MONTH = originalPriceId;
  }
});

test('only a verified new subscription event links a completed recurring checkout attempt', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalPriceId = process.env.PADDLE_PRICE_ID_1MONTH;
  process.env.PADDLE_PRICE_ID_1MONTH = 'pri_month_test';
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes('INSERT INTO paddle_webhook_events')) return { rowCount: 1, rows: [{ event_id: 'evt_monthsubscription' }] };
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  try {
    await processPaddleEvent({ async connect() { return client; } }, {
      eventId: 'evt_monthsubscription',
      eventType: 'subscription.created',
      occurredAt: '2026-10-30T18:00:00Z',
      data: {
        id: 'sub_0123456789abcdef01234567',
        status: 'active',
        customerId: 'ctm_0123456789abcdef01234567',
        customData: { userId: '00000000-0000-4000-8000-000000000001', plan: '1month', checkoutAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        transaction_id: 'txn_0123456789abcdef01234567',
        currentBillingPeriod: { endsAt: '2026-11-30T18:00:00Z' },
        items: [{ price: { id: 'pri_month_test' } }]
      }
    });
    const attemptUpdate = queries.find(query => query.sql.includes('UPDATE paddle_checkout_attempts'));
    assert.ok(attemptUpdate, 'expected the new subscription event to link the checkout attempt');
    assert.deepEqual(attemptUpdate.params, [
      '00000000-0000-4000-8000-000000000001',
      '1month',
      'txn_0123456789abcdef01234567',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    ]);
    assert.ok(attemptUpdate.sql.includes('attempt_id = $4'));
    assert.match(attemptUpdate.sql, /transaction_id IS NULL OR transaction_id = \$3/);
    const transactionEvidence = queries.find(query =>
      query.sql.includes('INSERT INTO paddle_transaction_events')
    );
    assert.ok(transactionEvidence,
      'a verified subscription.created event must retain provider transaction linkage evidence');
    assert.deepEqual(transactionEvidence.params.slice(0, 5), [
      'evt_monthsubscription',
      'txn_0123456789abcdef01234567',
      '00000000-0000-4000-8000-000000000001',
      '1month',
      'paid'
    ]);
    assert.equal(transactionEvidence.params[10], 'sub_0123456789abcdef01234567');
    assert.equal(transactionEvidence.params[11], 'ctm_0123456789abcdef01234567');
    const finalAttemptUpdate = queries.find(query =>
      query.sql.includes('SET status = $3') && query.sql.includes('transaction_id = $5')
    );
    assert.ok(finalAttemptUpdate, 'the final linked/reconciliation transition must remain scoped to this attempt');
    assert.deepEqual(finalAttemptUpdate.params, [
      '00000000-0000-4000-8000-000000000001',
      '1month',
      'linked',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'txn_0123456789abcdef01234567'
    ]);
  } finally {
    if (originalPriceId === undefined) delete process.env.PADDLE_PRICE_ID_1MONTH;
    else process.env.PADDLE_PRICE_ID_1MONTH = originalPriceId;
  }
});


test('confirmed checkout cancellation settles only the matching creating attempt', async () => {
  const { markPaddleCheckoutAttemptCanceled } = await import('./paddleBilling.js');
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return { rowCount: 1 };
    }
  };
  const result = await markPaddleCheckoutAttemptCanceled(client, {
    userId: '00000000-0000-4000-8000-000000000001',
    attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    transactionId: 'txn_0123456789abcdef01234567'
  });
  assert.equal(result, 1);
  assert.deepEqual(calls[0].params, [
    '00000000-0000-4000-8000-000000000001',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'txn_0123456789abcdef01234567'
  ]);
  assert.match(calls[0].sql, /status = 'creating'/);
  assert.match(calls[0].sql, /transaction_id = COALESCE\(transaction_id, \$3\)/);
  assert.match(calls[0].sql, /transaction_id IS NULL OR transaction_id = \$3/);
});

test('confirmed checkout cancellation rejects malformed attempt identity', async () => {
  const { markPaddleCheckoutAttemptCanceled } = await import('./paddleBilling.js');
  await assert.rejects(
    markPaddleCheckoutAttemptCanceled({ async query() { throw new Error('must not query'); } }, {
      userId: 'not-a-uuid',
      attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      transactionId: 'txn_0123456789abcdef01234567'
    }),
    /invalid_paddle_checkout_cancellation_identity/
  );
});

test('transaction.canceled webhook clears a pending checkout attempt', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes('INSERT INTO paddle_webhook_events')) return { rowCount: 1, rows: [{ event_id: 'evt_transaction_canceled' }] };
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  const result = await processPaddleEvent({ async connect() { return client; } }, {
    eventId: 'evt_transaction_canceled',
    eventType: 'transaction.canceled',
    data: { id: 'txn_0123456789abcdef01234567' }
  });
  assert.equal(result.handled, true);
  const attemptUpdate = queries.find(query => query.sql.includes('UPDATE paddle_checkout_attempts'));
  assert.ok(attemptUpdate, 'expected the canceled transaction to release the pending checkout lock');
  assert.equal(attemptUpdate.params[0], 'txn_0123456789abcdef01234567');
  assert.ok(attemptUpdate.sql.includes("status IN ('creating', 'pending', 'reconciliation_required')"));
  assert.ok(attemptUpdate.sql.includes('transaction_id = $1'),
    'legacy attempts remain matchable by their already-attached provider transaction ID');
  assert.ok(!attemptUpdate.sql.includes("status IN ('creating', 'pending', 'completed'"),
    'a delayed cancellation must not release an attempt already confirmed completed');
});


test('transaction.canceled webhook settles a creating attempt before checkout response attaches the transaction ID', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalPriceId = process.env.PADDLE_PRICE_ID_1MONTH;
  process.env.PADDLE_PRICE_ID_1MONTH = 'pri_month_test';
  try {
    const queries = [];
    const client = {
      async query(sql, params) {
        queries.push({ sql: String(sql), params });
        if (String(sql).includes('INSERT INTO paddle_webhook_events')) {
          return { rowCount: 1, rows: [{ event_id: 'evt_transaction_canceled_during_create' }] };
        }
        return { rowCount: 1, rows: [] };
      },
      release() {}
    };
    const result = await processPaddleEvent({ async connect() { return client; } }, {
      eventId: 'evt_transaction_canceled_during_create',
      eventType: 'transaction.canceled',
      data: {
        id: 'txn_0123456789abcdef01234567',
        items: [{ price: { id: 'pri_month_test' } }],
        custom_data: {
          userId: '00000000-0000-4000-8000-000000000001',
          plan: '1month',
          checkoutAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        }
      }
    });
    assert.equal(result.handled, true);
    const attemptUpdate = queries.find(query => query.sql.includes('UPDATE paddle_checkout_attempts'));
    assert.ok(attemptUpdate, 'expected the cancellation webhook to settle the creating attempt');
    assert.deepEqual(attemptUpdate.params, [
      'txn_0123456789abcdef01234567',
      '00000000-0000-4000-8000-000000000001',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '1month'
    ]);
    assert.ok(attemptUpdate.sql.includes('attempt_id = $3::uuid AND plan = $4'));
    assert.ok(attemptUpdate.sql.includes('transaction_id = COALESCE(transaction_id, $1)'));
    assert.ok(attemptUpdate.sql.includes("status IN ('creating', 'pending', 'reconciliation_required')"));
    assert.ok(!attemptUpdate.sql.includes("'completed'"),
      'the webhook must never downgrade a completed payment');
  } finally {
    if (originalPriceId === undefined) delete process.env.PADDLE_PRICE_ID_1MONTH;
    else process.env.PADDLE_PRICE_ID_1MONTH = originalPriceId;
  }
});


test('subscription.created cannot claim a checkout attempt for a different transaction', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalPriceId = process.env.PADDLE_PRICE_ID_1MONTH;
  process.env.PADDLE_PRICE_ID_1MONTH = 'pri_month_test';
  const queries = [];
  const client = {
    async query(sql, params) {
      const query = { sql: String(sql), params };
      queries.push(query);
      if (query.sql.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: 'evt_stale_subscription' }] };
      }
      if (query.sql.includes('UPDATE paddle_checkout_attempts')) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  try {
    await processPaddleEvent({ async connect() { return client; } }, {
      eventId: 'evt_stale_subscription',
      eventType: 'subscription.created',
      occurredAt: '2026-10-30T18:00:00Z',
      data: {
        id: 'sub_0123456789abcdef01234567',
        status: 'active',
        customerId: 'ctm_0123456789abcdef01234567',
        customData: { userId: '00000000-0000-4000-8000-000000000001', plan: '1month', checkoutAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        transaction_id: 'txn_aaaaaaaaaaaaaaaaaaaaaaaaaa',
        currentBillingPeriod: { endsAt: '2026-11-30T18:00:00Z' },
        items: [{ price: { id: 'pri_month_test' } }]
      }
    });
    const attemptUpdate = queries.find(query => query.sql.includes('UPDATE paddle_checkout_attempts'));
    assert.ok(attemptUpdate, 'expected the handler to attempt a transaction-bound claim');
    assert.deepEqual(attemptUpdate.params, [
      '00000000-0000-4000-8000-000000000001',
      '1month',
      'txn_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    ]);
    assert.ok(attemptUpdate.sql.includes('attempt_id = $4'));
    assert.equal(queries.some(query => query.sql.includes('UPDATE users')), false,
      'a subscription for a different transaction must not attach or grant Premium');
  } finally {
    if (originalPriceId === undefined) delete process.env.PADDLE_PRICE_ID_1MONTH;
    else process.env.PADDLE_PRICE_ID_1MONTH = originalPriceId;
  }
});

test('malformed Paddle customer IDs are acknowledged without persisting unusable account identity', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: 'evt_bad_customer' }] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {}
  };

  const result = await processPaddleEvent({ async connect() { return client; } }, {
    eventId: 'evt_bad_customer',
    eventType: 'customer.updated',
    data: {
      id: 'not-a-paddle-customer-id',
      email: 'member@example.test',
      customData: { userId: '00000000-0000-4000-8000-000000000001' }
    }
  });

  assert.deepEqual(result, { duplicate: false, handled: true });
  assert.equal(queries.some(query => query.sql.includes('UPDATE users')), false);
  assert.equal(queries.some(query => query.sql === 'COMMIT'), true);
  assert.equal(queries.some(query => query.sql === 'ROLLBACK'), false);
});

test('malformed customer IDs on completed transactions mark only the matching checkout attempt for reconciliation', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: 'evt_bad_transaction_customer' }] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {}
  };
  const result = await processPaddleEvent({ async connect() { return client; } }, {
    eventId: 'evt_bad_transaction_customer',
    eventType: 'transaction.completed',
    data: {
      id: 'txn_customerbad123',
      customerId: 'not-a-paddle-customer',
      customData: {
        userId: '00000000-0000-4000-8000-000000000001',
        plan: '3months',
        checkoutAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      }
    }
  });
  assert.deepEqual(result, { duplicate: false, handled: true });
  assert.equal(queries.some(query => query.sql.includes('UPDATE users')), false);
  const reconciliation = queries.find(query => query.sql.includes("SET status = 'reconciliation_required'"));
  assert.ok(reconciliation);
  assert.deepEqual(reconciliation.params, [
    '00000000-0000-4000-8000-000000000001',
    '3months',
    'txn_customerbad123',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ]);
  assert.equal(queries.some(query => query.sql === 'COMMIT'), true);
  assert.equal(queries.some(query => query.sql === 'ROLLBACK'), false);
});

test('malformed transaction cancellation IDs are acknowledged without database writes', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(String(sql));
      if (String(sql).includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: 'evt_bad_cancel_id' }] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {}
  };
  const result = await processPaddleEvent({ async connect() { return client; } }, {
    eventId: 'evt_bad_cancel_id',
    eventType: 'transaction.canceled',
    data: { id: 'not-a-transaction-id' }
  });
  assert.deepEqual(result, { duplicate: false, handled: true });
  assert.equal(queries.some(sql => sql.includes('UPDATE paddle_checkout_attempts')), false);
  assert.equal(queries.includes('COMMIT'), true);
  assert.equal(queries.includes('ROLLBACK'), false);
});

test('malformed subscription IDs in completed transactions reconcile only their checkout attempt', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: 'evt_bad_transaction_subscription' }] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {}
  };
  const result = await processPaddleEvent({ async connect() { return client; } }, {
    eventId: 'evt_bad_transaction_subscription',
    eventType: 'transaction.completed',
    data: {
      id: 'txn_valid123',
      subscriptionId: 'not-a-subscription-id',
      customData: {
        userId: '00000000-0000-4000-8000-000000000001',
        plan: '1month',
        checkoutAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      }
    }
  });
  assert.deepEqual(result, { duplicate: false, handled: true });
  assert.equal(queries.some(query => query.sql.includes('UPDATE users')), false);
  const reconciliation = queries.find(query => query.sql.includes("SET status = 'reconciliation_required'"));
  assert.ok(reconciliation, 'a malformed provider identity must leave the exact checkout attempt visible for manual reconciliation');
  assert.deepEqual(reconciliation.params, [
    '00000000-0000-4000-8000-000000000001',
    '1month',
    'txn_valid123',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ]);
  assert.equal(queries.some(query => query.sql === 'COMMIT'), true);
  assert.equal(queries.some(query => query.sql === 'ROLLBACK'), false);
});

test('Paddle identity unique conflicts reconcile only the matching checkout attempt', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalMonthlyPriceId = process.env.PADDLE_PRICE_ID_1MONTH;
  process.env.PADDLE_PRICE_ID_1MONTH = 'pri_vowmonthly';
  const queries = [];
  const client = {
    async query(sql, params) {
      const statement = String(sql);
      queries.push({ statement, params });
      if (statement.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: 'evt_identity_conflict' }] };
      }
      if (statement.includes('UPDATE users SET') && statement.includes('paddle_customer_id')) {
        const error = new Error('duplicate Paddle customer identity');
        error.code = '23505';
        throw error;
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };

  let result;
  try {
    result = await processPaddleEvent({ async connect() { return client; } }, {
      eventId: 'evt_identity_conflict',
      eventType: 'transaction.completed',
      data: {
        id: 'txn_identityconflict',
        customerId: 'ctm_identityconflict',
        customData: {
          userId: '00000000-0000-4000-8000-000000000001',
          plan: '1month',
          checkoutAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        },
        items: [{ price: { id: 'pri_vowmonthly' } }]
      }
    });
  } finally {
    if (originalMonthlyPriceId === undefined) delete process.env.PADDLE_PRICE_ID_1MONTH;
    else process.env.PADDLE_PRICE_ID_1MONTH = originalMonthlyPriceId;
  }

  assert.deepEqual(result, {
    duplicate: false,
    handled: true,
    reconciliationRequired: true
  });
  assert.equal(queries.some(query => query.statement === 'ROLLBACK TO SAVEPOINT paddle_event_effects'), true);
  const queuedConflict = queries.find(query =>
    query.statement.includes('INSERT INTO paddle_adjustment_reconciliation_cases')
  );
  assert.ok(queuedConflict, 'provider identity conflicts must remain visible in the moderator reconciliation queue');
  assert.deepEqual(queuedConflict.params, [
    'evt_identity_conflict',
    'provider_identity_conflict',
    'txn_identityconflict',
    null,
    '00000000-0000-4000-8000-000000000001',
    '1month'
  ]);
  const reconciliationUpdate = queries.find(query =>
    query.statement.includes("SET status = 'reconciliation_required'")
  );
  assert.ok(reconciliationUpdate, 'the conflicting checkout attempt must be marked for reconciliation');
  assert.ok(reconciliationUpdate.statement.includes('WHERE user_id = $1'));
  assert.ok(reconciliationUpdate.statement.includes('attempt_id = $4'));
  assert.ok(reconciliationUpdate.statement.includes('transaction_id = $3'));
  assert.doesNotMatch(reconciliationUpdate.statement, /'linked'|'canceled'/,
    'identity conflicts must not downgrade terminal checkout attempts');
  assert.deepEqual(reconciliationUpdate.params, [
    '00000000-0000-4000-8000-000000000001',
    '1month',
    'txn_identityconflict',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ]);
  const safetyLockIndex = queries.findIndex(query =>
    query.statement.includes('pg_advisory_xact_lock')
  );
  const accountUpdateIndex = queries.findIndex(query =>
    query.statement.includes('UPDATE users SET') && query.statement.includes('paddle_customer_id')
  );
  assert.ok(safetyLockIndex >= 0 && safetyLockIndex < accountUpdateIndex,
    'Paddle identity writes must wait for account deletion/safety serialization');
  assert.equal(queries.some(query => query.statement === 'COMMIT'), true);
  assert.equal(queries.some(query => query.statement === 'ROLLBACK'), false);
});

test('malformed Paddle subscription period timestamps persist no entitlement', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: 'evt_bad_period_end' }] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {}
  };
  const result = await processPaddleEvent({ async connect() { return client; } }, {
    eventId: 'evt_bad_period_end',
    eventType: 'subscription.updated',
    occurredAt: '2026-10-31T12:00:00Z',
    data: {
      id: 'sub_valid123',
      status: 'active',
      currentBillingPeriod: { endsAt: 'not-a-timestamp' },
      customData: { userId: '00000000-0000-4000-8000-000000000001' }
    }
  });
  assert.deepEqual(result, { duplicate: false, handled: true });
  const update = queries.find(query => query.sql.includes('UPDATE users SET'));
  assert.ok(update, 'lifecycle status should still be persisted');
  assert.equal(update.params[5], false, 'malformed period end must never grant Premium');
  assert.equal(update.params[6], null, 'malformed period end must be stored as no billing period');
  assert.equal(queries.some(query => query.sql === 'COMMIT'), true);
  assert.equal(queries.some(query => query.sql === 'ROLLBACK'), false);
});


test('Paddle webhook destroys a pooled client when transaction rollback fails', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalError = new Error('savepoint creation failed');
  const rollbackError = new Error('connection lost during rollback');
  const queries = [];
  let releasedWith;
  let releaseCount = 0;
  const client = {
    async query(sql) {
      queries.push(String(sql));
      if (sql === 'SAVEPOINT paddle_event_effects') throw originalError;
      if (sql === 'ROLLBACK') throw rollbackError;
      if (sql.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: 'evt_rollback_failure' }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release(error) { releaseCount += 1; releasedWith = error; }
  };

  await assert.rejects(
    processPaddleEvent({ async connect() { return client; } }, {
      eventId: 'evt_rollback_failure',
      eventType: 'unknown.event',
      data: {}
    }),
    error => error === originalError
  );
  assert.equal(releaseCount, 1);
  assert.equal(releasedWith, rollbackError);
  assert.deepEqual(queries.slice(-2), ['SAVEPOINT paddle_event_effects', 'ROLLBACK']);
});

test('Paddle webhook rolls back the outer transaction if identity-conflict reconciliation fails', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalMonthlyPriceId = process.env.PADDLE_PRICE_ID_1MONTH;
  process.env.PADDLE_PRICE_ID_1MONTH = 'pri_vowmonthly';
  const reconciliationError = new Error('reconciliation write failed');
  const queries = [];
  let releaseCount = 0;
  const client = {
    async query(sql) {
      const statement = String(sql);
      queries.push(statement);
      if (statement.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: 'evt_reconcile_failure' }] };
      }
      if (statement.includes('UPDATE users SET') && statement.includes('paddle_customer_id')) {
        const conflict = new Error('duplicate Paddle customer identity');
        conflict.code = '23505';
        throw conflict;
      }
      if (statement.includes("SET status = 'reconciliation_required'")) {
        throw reconciliationError;
      }
      return { rowCount: 1, rows: [] };
    },
    release() { releaseCount += 1; }
  };

  try {
    await assert.rejects(
      processPaddleEvent({ async connect() { return client; } }, {
        eventId: 'evt_reconcile_failure',
        eventType: 'transaction.completed',
        data: {
          id: 'txn_reconcilefailure',
          customerId: 'ctm_reconcilefailure',
          customData: {
            userId: '00000000-0000-4000-8000-000000000001',
            plan: '1month',
            checkoutAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
          },
          items: [{ price: { id: 'pri_vowmonthly' } }]
        }
      }),
      error => error === reconciliationError
    );
  } finally {
    if (originalMonthlyPriceId === undefined) delete process.env.PADDLE_PRICE_ID_1MONTH;
    else process.env.PADDLE_PRICE_ID_1MONTH = originalMonthlyPriceId;
  }

  assert.ok(queries.includes('ROLLBACK TO SAVEPOINT paddle_event_effects'));
  assert.ok(queries.includes('ROLLBACK'), 'the outer transaction must be rolled back after reconciliation failure');
  assert.equal(releaseCount, 1);
});


test('Paddle checkout route reuses its checked-out client instead of querying the pool recursively', async () => {
  const source = await readFile(new URL('./index.js', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/api/paddle/checkout'");
  const end = source.indexOf("app.post('/api/paddle/checkout", start + 10);
  assert.ok(start >= 0 && end > start, 'expected one bounded Paddle checkout route');
  const route = source.slice(start, end);
  assert.ok(route.includes('client = await pool.connect()'));
  assert.equal(route.includes('pool.query('), false,
    'a checked-out client must not wait for a second connection from the same pool');
  assert.ok(route.includes('await client.query('),
    'checkout attempt persistence must use the checked-out client');

  const committed = route.indexOf("await client.query('COMMIT');\n    attemptStarted = true;");
  const released = route.indexOf('client.release();\n    client = null;', committed);
  const providerRequest = route.indexOf("await fetch('https://sandbox-api.paddle.com/transactions'", released);
  const responseParsed = route.indexOf('const payload = await response.json()', providerRequest);
  const reconnected = route.indexOf('client = await pool.connect()', responseParsed);
  assert.ok(committed >= 0 && released > committed && providerRequest > released &&
    responseParsed > providerRequest && reconnected > responseParsed,
    'the database connection must be released during the external Paddle request and reacquired only to persist its result');
});

test('Paddle checkout reconciles a provider transaction when the account becomes inactive before response persistence', async () => {
  const source = await readFile(new URL('./index.js', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/api/paddle/checkout'");
  const end = source.indexOf("app.post('/api/paddle/checkout", start + 10);
  assert.ok(start >= 0 && end > start, 'expected one bounded Paddle checkout route');
  const route = source.slice(start, end);
  assert.match(route, /const recoveredStatus = providerTransactionStatus === 'canceled'/);
  assert.match(route, /SET transaction_id = COALESCE\(transaction_id, \$2\)/);
  assert.match(route, /status\s*=\s*CASE\s+WHEN\s+transaction_id IS NULL OR transaction_id = \$2 THEN \$4\s+ELSE 'reconciliation_required'\s+END/s);
  assert.match(route, /AND status = 'creating'/);
  assert.match(route, /providerTransactionStatus = canceledTransaction\.status/);
  assert.match(route, /paddle_checkout_reconciliation_required/);
  assert.match(route, /paddle_checkout_cancelled/);
  assert.match(route, /let providerTransactionId = null/);
  assert.match(route, /providerTransactionId = transactionId/);
  const payloadParsed = route.indexOf('const payload = await response.json()');
  const providerIdCaptured = route.indexOf('providerTransactionId = transactionId');
  const databaseReconnected = route.indexOf('client = await pool.connect()', payloadParsed);
  assert.ok(payloadParsed >= 0 && providerIdCaptured > payloadParsed && databaseReconnected > providerIdCaptured,
    'capture the validated provider transaction ID before attempting to reconnect to PostgreSQL');
  assert.match(route, /SET transaction_id = COALESCE\(transaction_id, \$3\)/);
  assert.match(route, /providerTransactionId\]/);
});

test('completed Paddle transactions recover account ownership from archived checkout attempts', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalMonthlyPriceId = process.env.PADDLE_PRICE_ID_1MONTH;
  process.env.PADDLE_PRICE_ID_1MONTH = 'pri_vowmonthly';
  const userId = '00000000-0000-4000-8000-000000000001';
  const transactionId = 'txn_archivedattempt123456789';
  const queries = [];
  const client = {
    async query(sql, params = []) {
      const statement = String(sql);
      queries.push({ statement, params });
      if (statement.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: params[0] }] };
      }
      if (statement.includes('SELECT DISTINCT user_id') && statement.includes('paddle_checkout_attempt_history')) {
        return { rowCount: 1, rows: [{ user_id: userId }] };
      }
      if (statement.includes('UPDATE paddle_checkout_attempts') && statement.includes('SET transaction_id = $1')) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  try {
    const result = await processPaddleEvent({ async connect() { return client; } }, {
      eventId: 'evt_archivedattemptowner123456',
      eventType: 'transaction.completed',
      occurredAt: '2026-11-03T10:00:00Z',
      data: {
        id: transactionId,
        items: [{ price: { id: 'pri_vowmonthly' } }],
        customData: {
          userId,
          plan: '1month',
          checkoutAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        }
      }
    });
    assert.equal(result.handled, true);
    const ledger = queries.find(query => query.statement.includes('INSERT INTO paddle_transaction_events'));
    assert.ok(ledger);
    assert.equal(ledger.params[2], userId,
      'archived checkout history must preserve the account owner for recurring renewal evidence');
    const reconciliation = queries.find(query =>
      query.statement.includes('UPDATE paddle_adjustment_reconciliation_cases')
    );
    assert.ok(reconciliation,
      'an early adjustment case can be reconciled once the recurring transaction owner is known');
    assert.ok(reconciliation.statement.includes("cases.reason_code = 'transaction_owner_unlinked'"),
      'ambiguous, inactive-account, malformed, and missing-entitlement cases must remain open for manual review');
    assert.ok(reconciliation.statement.includes('COUNT(DISTINCT (user_id, plan))'),
      'automatic resolution must require one unique transaction owner and plan');
  } finally {
    if (originalMonthlyPriceId === undefined) delete process.env.PADDLE_PRICE_ID_1MONTH;
    else process.env.PADDLE_PRICE_ID_1MONTH = originalMonthlyPriceId;
  }
});

test('transaction history does not substitute legacy top-level amount for Paddle details.totals.total', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const statement = String(sql);
      calls.push({ statement, params });
      if (statement.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: params[0] }] };
      }
      if (statement.includes('SELECT DISTINCT user_id')) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };

  await processPaddleEvent({ async connect() { return client; } }, {
    eventId: 'evt_transaction_legacy_amount_only',
    eventType: 'transaction.completed',
    occurredAt: '2026-11-03T10:00:00Z',
    data: {
      id: 'txn_transactionlegacyamount123',
      total: '16500',
      amount: '16500',
      details: { totals: { grand_total: '16500' } },
      currency: 'USD'
    }
  });

  const ledger = calls.find(call => call.statement.includes('INSERT INTO paddle_transaction_events'));
  assert.ok(ledger, 'the provider transaction event must still be retained');
  assert.equal(ledger.params[5], null,
    'top-level legacy amount must not be treated as an authoritative Paddle transaction total');
  assert.equal(ledger.params[6], '16500',
    'the documented grand total remains distinct even when gross total is missing');
  assert.equal(ledger.params[7], null);
  assert.equal(ledger.params[8], null);
  assert.equal(ledger.params[9], null,
    'a noncanonical currency property must not substitute for Paddle currency_code');
});

test('ambiguous cross-account Paddle transaction ownership is retained without assigning an owner', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalPriceId = process.env.PADDLE_PRICE_ID_1MONTH;
  process.env.PADDLE_PRICE_ID_1MONTH = 'pri_month_ambiguous_owner';
  const userId = '00000000-0000-4000-8000-000000000071';
  const attemptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa71';
  const transactionId = 'txn_ambiguouscrossaccountowner123';
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const statement = String(sql);
      calls.push({ statement, params });
      if (statement.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: params[0] }] };
      }
      if (statement.includes('COUNT(DISTINCT user_id) > 1')) {
        return { rowCount: 1, rows: [{ ambiguous: true }] };
      }
      if (statement.includes('UPDATE paddle_checkout_attempts') && statement.includes('SET transaction_id = $1')) {
        return { rowCount: 0, rows: [] };
      }
      if (statement.includes('SELECT DISTINCT user_id') && statement.includes('paddle_checkout_attempt_history')) {
        return {
          rowCount: 2,
          rows: [
            { user_id: userId },
            { user_id: '00000000-0000-4000-8000-000000000072' }
          ]
        };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };

  try {
    const result = await processPaddleEvent({ async connect() { return client; } }, {
      eventId: 'evt_ambiguous_cross_account_owner',
      eventType: 'transaction.completed',
      occurredAt: '2026-11-04T00:00:00Z',
      data: {
        id: transactionId,
        customData: { userId, plan: '1month', checkoutAttemptId: attemptId },
        items: [{ price: { id: 'pri_month_ambiguous_owner' } }],
        details: { totals: { total: '990', grand_total: '900', credit: '90', balance: '0' } },
        currency_code: 'GEL'
      }
    });

    assert.equal(result.handled, true);
    const ledger = calls.find(call => call.statement.includes('INSERT INTO paddle_transaction_events'));
    assert.ok(ledger, 'the provider transaction must remain in the append-only ledger');
    assert.equal(ledger.params[2], null,
      'a transaction claimed by more than one account must not be assigned to either account');
    assert.equal(ledger.params[3], '1month');
    assert.equal(ledger.params[5], '990');
    assert.equal(ledger.params[6], '900');
    assert.equal(ledger.params[7], '90');
    assert.equal(ledger.params[8], '0');
    assert.equal(ledger.params[9], 'GEL');
    assert.equal(calls.some(call => call.statement.includes('UPDATE paddle_checkout_attempts')), false,
      'ambiguous transaction ownership must not mutate any account checkout attempt');
    assert.ok(calls.some(call => call.statement.includes('INSERT INTO paddle_adjustment_reconciliation_cases')),
      'ambiguous transaction ownership must be retained in the provider reconciliation queue');
    assert.equal(calls.some(call => call.statement.includes('UPDATE users SET')), false,
      'ambiguous ownership must never grant or mutate an account entitlement');
  } finally {
    if (originalPriceId === undefined) delete process.env.PADDLE_PRICE_ID_1MONTH;
    else process.env.PADDLE_PRICE_ID_1MONTH = originalPriceId;
  }
});



test('transaction.completed quarantines custom_data owner that contradicts the retained transaction owner', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalPriceId = process.env.PADDLE_PRICE_ID_1MONTH;
  process.env.PADDLE_PRICE_ID_1MONTH = 'pri_monthownerconflict';
  const ownerA = '00000000-0000-4000-8000-000000000081';
  const ownerB = '00000000-0000-4000-8000-000000000082';
  const transactionId = 'txn_ownerconflicttransaction123';
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const statement = String(sql);
      calls.push({ statement, params });
      if (statement.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: params[0] }] };
      }
      if (statement.includes("SET transaction_id = $1, status = 'completed'")) {
        return { rowCount: 0, rows: [] };
      }
      if (statement.includes('SELECT DISTINCT user_id') && statement.includes('paddle_checkout_attempt_history')) {
        return { rowCount: 1, rows: [{ user_id: ownerA }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  try {
    await processPaddleEvent({ async connect() { return client; } }, {
      eventId: 'evt_owner_conflict_transaction',
      eventType: 'transaction.completed',
      occurredAt: '2026-11-04T12:00:00Z',
      data: {
        id: transactionId,
        customData: {
          userId: ownerB,
          plan: '1month',
          checkoutAttemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        },
        items: [{ price: { id: 'pri_monthownerconflict' } }]
      }
    });
    const ledger = calls.find(call => call.statement.includes('INSERT INTO paddle_transaction_events'));
    assert.ok(ledger, calls.map(call => call.statement).join('\n---\n'));
    assert.equal(ledger.params[2], null,
      'contradictory signed custom_data must not be attributed to the previously linked account');
    const conflict = calls.find(call => call.statement.includes('INSERT INTO paddle_adjustment_reconciliation_cases'));
    assert.ok(conflict, 'the provider identity contradiction must be retained in the reconciliation queue');
    assert.equal(conflict.params[0], 'evt_owner_conflict_transaction');
    assert.equal(conflict.params[1], transactionId);
    assert.equal(conflict.params[2], ownerB);
    assert.equal(conflict.params[3], '1month');
    assert.equal(calls.some(call => call.statement.includes('UPDATE users SET')), false);
  } finally {
    if (originalPriceId === undefined) delete process.env.PADDLE_PRICE_ID_1MONTH;
    else process.env.PADDLE_PRICE_ID_1MONTH = originalPriceId;
  }
});


test('transaction.completed quarantines custom_data plan that contradicts the configured Paddle price', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalPriceId = process.env.PADDLE_PRICE_ID_LIFETIME;
  process.env.PADDLE_PRICE_ID_LIFETIME = 'pri_lifetimeplanconflict';
  const ownerId = '00000000-0000-4000-8000-000000000083';
  const transactionId = 'txn_planconflicttransaction123';
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const statement = String(sql);
      calls.push({ statement, params });
      if (statement.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: params[0] }] };
      }
      if (statement.includes("SET transaction_id = $1, status = 'completed'")) {
        return { rowCount: 0, rows: [] };
      }
      if (statement.includes('SELECT DISTINCT user_id') && statement.includes('paddle_checkout_attempt_history')) {
        return { rowCount: 1, rows: [{ user_id: ownerId }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  try {
    await processPaddleEvent({ async connect() { return client; } }, {
      eventId: 'evt_plan_conflict_transaction',
      eventType: 'transaction.completed',
      occurredAt: '2026-11-04T12:10:00Z',
      data: {
        id: transactionId,
        customData: {
          userId: ownerId,
          plan: '1month',
          checkoutAttemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
        },
        items: [{ price: { id: 'pri_lifetimeplanconflict' } }]
      }
    });
    const ledger = calls.find(call => call.statement.includes('INSERT INTO paddle_transaction_events'));
    assert.ok(ledger);
    assert.equal(ledger.params[2], null,
      'the owner must remain unassigned when signed plan metadata contradicts the configured provider price');
    const conflict = calls.find(call => call.statement.includes('INSERT INTO paddle_adjustment_reconciliation_cases'));
    assert.ok(conflict);
    assert.equal(conflict.params[2], ownerId);
    assert.equal(conflict.params[3], '1month');
    assert.equal(calls.some(call => call.statement.includes('premium_lifetime = TRUE')), false);
  } finally {
    if (originalPriceId === undefined) delete process.env.PADDLE_PRICE_ID_LIFETIME;
    else process.env.PADDLE_PRICE_ID_LIFETIME = originalPriceId;
  }
});


test('transaction.paid quarantines custom_data owner that contradicts the retained transaction owner', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const ownerA = '00000000-0000-4000-8000-000000000091';
  const ownerB = '00000000-0000-4000-8000-000000000092';
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const statement = String(sql);
      calls.push({ statement, params });
      if (statement.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: params[0] }] };
      }
      if (statement.includes('SELECT DISTINCT user_id') && statement.includes('paddle_checkout_attempt_history')) {
        return { rowCount: 1, rows: [{ user_id: ownerA }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  await processPaddleEvent({ async connect() { return client; } }, {
    eventId: 'evt_paid_owner_conflict_transaction',
    eventType: 'transaction.paid',
    occurredAt: '2026-11-04T12:05:00Z',
    data: {
      id: 'txn_paidownerconflicttransaction123',
      customData: { userId: ownerB, plan: '3months' },
      items: [{ price: { id: 'pri_unknown_paid_plan' } }]
    }
  });
  const ledger = calls.find(call => call.statement.includes('INSERT INTO paddle_transaction_events'));
  assert.ok(ledger, calls.map(call => call.statement).join('\n---\n'));
  assert.equal(ledger.params[2], null,
    'captured payment metadata must not be attributed to a different retained account');
  assert.equal(calls.some(call => call.statement.includes('INSERT INTO paddle_adjustment_reconciliation_cases')), false,
    'transaction.paid is intermediate capture evidence; final transaction.completed owns durable conflict reconciliation');
});



test('transaction.completed quarantines conflicting camelCase and snake_case owner metadata', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalPriceId = process.env.PADDLE_PRICE_ID_1MONTH;
  process.env.PADDLE_PRICE_ID_1MONTH = 'pri_monthaliasconflict';
  const ownerA = '00000000-0000-4000-8000-000000000084';
  const ownerB = '00000000-0000-4000-8000-000000000085';
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const statement = String(sql);
      calls.push({ statement, params });
      if (statement.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: params[0] }] };
      }
      if (statement.includes("SET transaction_id = $1, status = 'completed'")) {
        return { rowCount: 0, rows: [] };
      }
      if (statement.includes('SELECT DISTINCT user_id') && statement.includes('paddle_checkout_attempt_history')) {
        return { rowCount: 1, rows: [{ user_id: ownerA }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  try {
    await processPaddleEvent({ async connect() { return client; } }, {
      eventId: 'evt_conflicting_owner_aliases',
      eventType: 'transaction.completed',
      occurredAt: '2026-11-04T12:20:00Z',
      data: {
        id: 'txn_owneraliasesconflict123',
        customData: {
          userId: ownerA,
          user_id: ownerB,
          plan: '1month',
          checkoutAttemptId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
        },
        items: [{ price: { id: 'pri_monthaliasconflict' } }]
      }
    });
    const ledger = calls.find(call => call.statement.includes('INSERT INTO paddle_transaction_events'));
    assert.ok(ledger);
    assert.equal(ledger.params[2], null,
      'conflicting provider owner aliases must not be resolved by field precedence');
    const conflict = calls.find(call => call.statement.includes('INSERT INTO paddle_adjustment_reconciliation_cases'));
    assert.ok(conflict);
    assert.equal(conflict.params[2], null,
      'a conflicting pair of owner aliases must not snapshot either value as authoritative');
    assert.equal(calls.some(call => call.statement.includes('UPDATE paddle_checkout_attempts')), false,
      'ambiguous owner aliases must not mark either account checkout attempt for reconciliation');
  } finally {
    if (originalPriceId === undefined) delete process.env.PADDLE_PRICE_ID_1MONTH;
    else process.env.PADDLE_PRICE_ID_1MONTH = originalPriceId;
  }
});

test('transaction.completed quarantines a supplied but unrecognized custom_data plan', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalPriceId = process.env.PADDLE_PRICE_ID_1MONTH;
  process.env.PADDLE_PRICE_ID_1MONTH = 'pri_monthunknownmetadataplan';
  const ownerId = '00000000-0000-4000-8000-000000000086';
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const statement = String(sql);
      calls.push({ statement, params });
      if (statement.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: params[0] }] };
      }
      if (statement.includes("SET transaction_id = $1, status = 'completed'")) {
        return { rowCount: 0, rows: [] };
      }
      if (statement.includes('SELECT DISTINCT user_id') && statement.includes('paddle_checkout_attempt_history')) {
        return { rowCount: 1, rows: [{ user_id: ownerId }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  try {
    await processPaddleEvent({ async connect() { return client; } }, {
      eventId: 'evt_unknown_custom_data_plan',
      eventType: 'transaction.completed',
      occurredAt: '2026-11-04T12:25:00Z',
      data: {
        id: 'txn_unknowncustomplan123',
        customData: {
          userId: ownerId,
          plan: 'unknown_plan',
          checkoutAttemptId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
        },
        items: [{ price: { id: 'pri_monthunknownmetadataplan' } }]
      }
    });
    const ledger = calls.find(call => call.statement.includes('INSERT INTO paddle_transaction_events'));
    assert.ok(ledger);
    assert.equal(ledger.params[2], null,
      'a provider transaction with malformed supplied plan metadata must remain unassigned');
    assert.ok(calls.some(call => call.statement.includes('INSERT INTO paddle_adjustment_reconciliation_cases')));
  } finally {
    if (originalPriceId === undefined) delete process.env.PADDLE_PRICE_ID_1MONTH;
    else process.env.PADDLE_PRICE_ID_1MONTH = originalPriceId;
  }
});


test('Paddle transaction history preserves negative totals from credit subscription updates', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const statement = String(sql);
      calls.push({ statement, params });
      if (statement.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: params[0] }] };
      }
      if (statement.includes('SELECT DISTINCT user_id')) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };

  await processPaddleEvent({ async connect() { return client; } }, {
    eventId: 'evt_negative_subscription_credit_total',
    eventType: 'transaction.completed',
    occurredAt: '2026-11-04T00:30:00Z',
    data: {
      id: 'txn_negativeSubscriptionCredit123',
      details: {
        totals: {
          total: '-500',
          grand_total: '-500',
          credit: '0',
          balance: '0'
        }
      },
      currency_code: 'GEL'
    }
  });

  const ledger = calls.find(call => call.statement.includes('INSERT INTO paddle_transaction_events'));
  assert.ok(ledger, 'credit transactions must remain in the append-only transaction ledger');
  assert.equal(ledger.params[5], '-500',
    'Paddle transaction total may be negative for subscription updates that result in credit');
  assert.equal(ledger.params[6], '-500');
  assert.equal(ledger.params[7], '0');
  assert.equal(ledger.params[8], '0');
  assert.equal(ledger.params[9], 'GEL');
});


test('Paddle paid transactions remain in reconciliation until transaction.completed before cancellation or account deletion', async () => {
  const source = await readFile(new URL('./index.js', import.meta.url), 'utf8');
  const cancelStart = source.indexOf("app.post('/api/paddle/checkout/cancel'");
  const cancelEnd = source.indexOf("app.post('/api/paddle/portal'", cancelStart + 10);
  assert.ok(cancelStart >= 0 && cancelEnd > cancelStart, 'expected the bounded checkout cancellation route');
  const cancelRoute = source.slice(cancelStart, cancelEnd);
  assert.match(cancelRoute, /providerTransaction\.status === 'completed'/);
  assert.ok(cancelRoute.includes("['completed', 'paid'].includes(providerTransaction.status)"));
  assert.ok(cancelRoute.includes("const status = providerTransaction.status === 'completed'\n        ? 'completed'\n        : 'reconciliation_required';"));
  assert.doesNotMatch(cancelRoute, /\['completed', 'paid'\]\.includes\(providerTransaction\.status\)\s*\?\s*'completed'/);

  const deleteStart = source.indexOf("app.delete('/api/account'");
  const deleteEnd = source.indexOf("app.get('/api/billing/status'", deleteStart + 10);
  assert.ok(deleteStart >= 0 && deleteEnd > deleteStart, 'expected the bounded account deletion route');
  const deleteRoute = source.slice(deleteStart, deleteEnd);
  assert.match(deleteRoute, /providerTransaction\.status === 'paid'/);
  assert.match(deleteRoute, /status = 'reconciliation_required'/);
  assert.match(deleteRoute, /providerTransaction\.status === 'completed'/);
  assert.doesNotMatch(deleteRoute, /\['completed', 'paid'\]\.includes\(providerTransaction\.status\)/);
});


test('transaction.paid is retained as captured payment without granting or finalizing access', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const queries = [];
  const client = {
    async query(sql, params = []) {
      const statement = String(sql);
      queries.push({ statement, params });
      if (statement.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: 'evt_transactionpaid' }] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {}
  };
  const originalMonthlyPriceId = process.env.PADDLE_PRICE_ID_1MONTH;
  process.env.PADDLE_PRICE_ID_1MONTH = 'pri_month_test';
  let result;
  try {
    result = await processPaddleEvent({ async connect() { return client; } }, {
      eventId: 'evt_transactionpaid',
      eventType: 'transaction.paid',
      occurredAt: '2026-11-04T08:00:00Z',
      data: {
        id: 'txn_transactionpaid',
        customerId: 'ctm_0123456789abcdef01234567',
        items: [{ price: { id: 'pri_month_test' } }],
        details: { totals: { total: '990', grand_total: '990', credit: '0', balance: '0' } },
        currencyCode: 'GEL'
      }
    });
  } finally {
    if (originalMonthlyPriceId === undefined) delete process.env.PADDLE_PRICE_ID_1MONTH;
    else process.env.PADDLE_PRICE_ID_1MONTH = originalMonthlyPriceId;
  }
  assert.deepEqual(result, { duplicate: false, handled: true });
  const ledger = queries.find(query => query.statement.includes('INSERT INTO paddle_transaction_events'));
  assert.ok(ledger, 'captured payment must be retained independently of later transaction completion');
  assert.deepEqual(ledger.params.slice(0, 5), [
    'evt_transactionpaid', 'txn_transactionpaid', null, '1month', 'paid'
  ]);
  assert.equal(queries.some(query => query.statement.includes('UPDATE users')), false,
    'transaction.paid alone must not grant recurring or lifetime access');
  assert.equal(queries.some(query => query.statement.includes('UPDATE paddle_checkout_attempts')), false,
    'transaction.paid alone must not finalize or link the checkout attempt');
  const transactionLockIndex = queries.findIndex(query =>
    query.statement.includes("pg_advisory_xact_lock(hashtextextended('paddle-transaction:'")
  );
  const ledgerIndex = queries.findIndex(query =>
    query.statement.includes('INSERT INTO paddle_transaction_events')
  );
  assert.ok(transactionLockIndex >= 0 && ledgerIndex > transactionLockIndex,
    'paid events must serialize with transaction completion and adjustment processing');
});

test('Paddle adjustment identity migration freezes ledger writes before preflight', async () => {
  const migration = await readFile(
    new URL('./migrations/184_guard_paddle_adjustment_identity.sql', import.meta.url),
    'utf8'
  );
  const lockIndex = migration.indexOf('LOCK TABLE paddle_adjustment_events IN SHARE ROW EXCLUSIVE MODE;');
  const preflightIndex = migration.indexOf('DO $migration184$');
  const triggerIndex = migration.indexOf('CREATE TRIGGER paddle_adjustment_events_identity_guard');
  assert.ok(lockIndex >= 0 && preflightIndex > lockIndex && triggerIndex > preflightIndex,
    'migration 184 must block concurrent adjustment writes across conflict preflight and identity-trigger installation');
});

test('transaction.completed acquires the users table lock before transaction evidence writes', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalLifetimePriceId = process.env.PADDLE_PRICE_ID_LIFETIME;
  process.env.PADDLE_PRICE_ID_LIFETIME = 'pri_vowlifetime_lock_order';
  const userId = '00000000-0000-4000-8000-000000000001';
  const transactionId = 'txn_completedlockorder123456';
  const queries = [];
  const client = {
    async query(sql, params = []) {
      const statement = String(sql);
      queries.push({ statement, params });
      if (statement.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: params[0] }] };
      }
      if (statement.includes('UPDATE paddle_checkout_attempts') &&
          statement.includes('SET transaction_id = $1')) {
        return { rowCount: 1, rows: [{ user_id: userId }] };
      }
      if (statement.includes('SELECT DISTINCT user_id') &&
          statement.includes('paddle_checkout_attempt_history')) {
        return { rowCount: 1, rows: [{ user_id: userId }] };
      }
      if (statement.includes('INSERT INTO paddle_lifetime_entitlements')) {
        return { rowCount: 1, rows: [{ transaction_id: transactionId }] };
      }
      if (statement.includes('WITH latest_per_adjustment AS')) {
        return { rowCount: 1, rows: [{
          full_refund_active: false,
          chargeback_active: false,
          full_refund_reversed: false,
          chargeback_reversed: false
        }] };
      }
      if (statement.includes('UPDATE users SET')) {
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  try {
    const result = await processPaddleEvent({ async connect() { return client; } }, {
      eventId: 'evt_completedlockorder123456',
      eventType: 'transaction.completed',
      occurredAt: '2026-11-04T09:00:00Z',
      data: {
        id: transactionId,
        customerId: 'ctm_completedlockorder123456',
        items: [{ price: { id: 'pri_vowlifetime_lock_order' } }],
        details: { totals: { total: '9900', grand_total: '9900' } },
        currencyCode: 'USD',
        customData: {
          userId,
          plan: 'lifetime',
          checkoutAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        }
      }
    });
    assert.equal(result.handled, true);
    const usersTableLockIndex = queries.findIndex(query =>
      query.statement === 'LOCK TABLE users IN ROW EXCLUSIVE MODE'
    );
    const ledgerIndex = queries.findIndex(query =>
      query.statement.includes('INSERT INTO paddle_transaction_events')
    );
    const userUpdateIndex = queries.findIndex(query =>
      query.statement.includes('UPDATE users SET') && query.statement.includes('premium_lifetime = TRUE')
    );
    assert.ok(usersTableLockIndex >= 0,
      'transaction.completed must acquire the users table lock before inserting provider evidence');
    assert.ok(ledgerIndex > usersTableLockIndex,
      'transaction evidence must follow the users table lock used by migration 183');
    assert.ok(userUpdateIndex > ledgerIndex,
      'the completion handler still performs its entitlement update after durable transaction evidence');
  } finally {
    if (originalLifetimePriceId === undefined) delete process.env.PADDLE_PRICE_ID_LIFETIME;
    else process.env.PADDLE_PRICE_ID_LIFETIME = originalLifetimePriceId;
  }
});

test('Paddle adjustment conflict migration preserves provider adjustment identity and audits it', async () => {
  const migration = await readFile(
    new URL('./migrations/185_preserve_conflicting_adjustment_identity.sql', import.meta.url),
    'utf8'
  );
  assert.match(migration,
    /ADD COLUMN provider_adjustment_id TEXT[\s\S]*\^adj_\[A-Za-z0-9\]\+\$/);
  assert.match(migration,
    /NEW\.provider_adjustment_id IS DISTINCT FROM OLD\.provider_adjustment_id/);
  assert.match(migration,
    /audit\.details->>'adjustmentId'[\s\S]*NEW\.provider_adjustment_id/);
});

test('Paddle manual resolution refuses to close a refund until a later provider event verifies its scope', async () => {
  const migration = await readFile(
    new URL('./migrations/204_require_verified_refund_scope_before_manual_closure.sql', import.meta.url),
    'utf8'
  );
  assert.ok(migration.includes("NEW.reason_code = 'invalid_adjustment_payload'"));
  assert.ok(migration.includes("source.action = 'refund'"));
  assert.ok(migration.includes("source.adjustment_type IS NULL"));
  assert.ok(migration.includes("verified_scope.adjustment_type IN ('full', 'partial')"));
  const lock = migration.match(/LOCK TABLE ([^;]+) IN SHARE ROW EXCLUSIVE MODE;/);
  assert.deepEqual(lock?.[1].split(',').map(table => table.trim()),
    ['paddle_adjustment_events', 'paddle_adjustment_reconciliation_cases'],
    'migration lock order must match webhook insertion order');

  const api = await readFile(new URL('./index.js', import.meta.url), 'utf8');
  assert.ok(api.includes('has_verified_refund_scope'));
  assert.ok(api.includes('refund_scope_requires_provider_verified_reconciliation'));
  assert.ok(api.includes("verified_scope.adjustment_type IN ('full', 'partial')"));
});

test('Paddle manual resolution migration keeps unverified ownership cases open', async () => {
  const migration = await readFile(
    new URL('./migrations/186_block_unverified_manual_adjustment_closure.sql', import.meta.url),
    'utf8'
  );
  assert.match(migration,
    /NEW\.reason_code NOT IN \([\s\S]*'invalid_adjustment_payload'[\s\S]*'provider_identity_conflict'[\s\S]*'provider_lifecycle_conflict'/);
  assert.match(migration,
    /webhook\.event_type IN \([\s\S]*'adjustment\.created'[\s\S]*'adjustment\.updated'[\s\S]*'customer\.created'[\s\S]*'customer\.updated'/,
    'transaction and subscription lifecycle conflicts must remain open for verified transaction reconciliation');
  const lockIndex = migration.indexOf('LOCK TABLE paddle_adjustment_reconciliation_cases IN SHARE ROW EXCLUSIVE MODE;');
  const functionIndex = migration.indexOf('CREATE OR REPLACE FUNCTION require_manual_paddle_adjustment_resolution_audit()');
  assert.ok(lockIndex >= 0 && functionIndex > lockIndex,
    'the migration must drain in-flight case resolutions before replacing the deferred commit guard');
  assert.match(migration,
    /unresolved\/ambiguous owner links, inactive accounts and missing entitlements cannot be cleared by a note/);
});

test('Paddle identity migration acquires table locks in the application write order', async () => {
  const migration = await readFile(
    new URL('./migrations/183_guard_paddle_provider_identity_consistency.sql', import.meta.url),
    'utf8'
  );
  const lock = migration.match(/LOCK TABLE ([^;]+) IN SHARE ROW EXCLUSIVE MODE;/);
  assert.ok(lock, 'migration 183 must freeze the identity evidence tables during its preflight');
  assert.deepEqual(
    lock[1].split(',').map(table => table.trim()),
    ['users', 'paddle_transaction_events'],
    'subscription.created writes users before transaction evidence, and transaction.completed explicitly acquires the users table lock before its later entitlement update; migration locks must use this common order to avoid online-migration deadlocks'
  );
});

test('subscription.created locks its originating Paddle transaction before user and evidence writes', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalPriceId = process.env.PADDLE_PRICE_ID_1MONTH;
  process.env.PADDLE_PRICE_ID_1MONTH = 'pri_vowmonthly_lock_order';
  const queries = [];
  const client = {
    async query(sql, params = []) {
      const statement = String(sql);
      queries.push({ statement, params });
      if (statement.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: params[0] }] };
      }
      if (statement.includes('UPDATE paddle_checkout_attempts') &&
          statement.includes('SET transaction_id = $3')) {
        return { rowCount: 1, rows: [{ user_id: params[0] }] };
      }
      if (statement.includes('UPDATE users SET')) {
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  try {
    const result = await processPaddleEvent({ async connect() { return client; } }, {
      eventId: 'evt_subscription_created_lock_order',
      eventType: 'subscription.created',
      occurredAt: '2026-11-04T09:00:00Z',
      data: {
        id: 'sub_subscriptioncreatedlock123',
        transactionId: 'txn_subscriptioncreatedlock123',
        customerId: 'ctm_subscriptioncreatedlock123',
        status: 'active',
        currentBillingPeriod: { endsAt: '2027-01-04T09:00:00Z' },
        items: [{ price: { id: 'pri_vowmonthly_lock_order' } }],
        customData: {
          userId: '00000000-0000-4000-8000-000000000001',
          plan: '1month',
          checkoutAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        }
      }
    });
    assert.equal(result.handled, true);
    const transactionLockIndex = queries.findIndex(query =>
      query.statement.includes("pg_advisory_xact_lock(hashtextextended('paddle-transaction:'")
    );
    const userLockIndex = queries.findIndex(query =>
      query.statement.includes('SELECT id FROM users WHERE id = $1 FOR UPDATE')
    );
    const userUpdateIndex = queries.findIndex(query => query.statement.includes('UPDATE users SET'));
    const ledgerIndex = queries.findIndex(query =>
      query.statement.includes('INSERT INTO paddle_transaction_events')
    );
    assert.ok(transactionLockIndex >= 0, 'subscription.created must lock the originating transaction');
    assert.ok(userLockIndex > transactionLockIndex,
      'the transaction lock must precede the user row lock');
    assert.ok(userUpdateIndex > transactionLockIndex,
      'the transaction lock must precede provider identity writes');
    assert.ok(ledgerIndex > userUpdateIndex,
      'the regression case must exercise the user-then-ledger write path');
  } finally {
    if (originalPriceId === undefined) delete process.env.PADDLE_PRICE_ID_1MONTH;
    else process.env.PADDLE_PRICE_ID_1MONTH = originalPriceId;
  }
});


test('transaction.completed does not claim or entitle a checkout when owner aliases conflict', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalPriceId = process.env.PADDLE_PRICE_ID_1MONTH;
  process.env.PADDLE_PRICE_ID_1MONTH = 'pri_monthambiguousowner';
  const ownerA = '00000000-0000-4000-8000-000000000101';
  const ownerB = '00000000-0000-4000-8000-000000000102';
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const statement = String(sql);
      calls.push({ statement, params });
      if (statement.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: params[0] }] };
      }
      if (statement.includes('SELECT DISTINCT user_id') && statement.includes('paddle_checkout_attempt_history')) {
        return { rowCount: 1, rows: [{ user_id: ownerA }] };
      }
      if (statement.includes("SET transaction_id = $1, status = 'completed'")) {
        return { rowCount: 1, rows: [{ user_id: ownerA }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  try {
    await processPaddleEvent({ async connect() { return client; } }, {
      eventId: 'evt_ambiguous_owner_must_not_claim',
      eventType: 'transaction.completed',
      occurredAt: '2026-11-05T10:00:00Z',
      data: {
        id: 'txn_ambiguousownerclaim123',
        customData: {
          userId: ownerA,
          user_id: ownerB,
          plan: '1month',
          checkoutAttemptId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
        },
        items: [{ price: { id: 'pri_monthambiguousowner' } }]
      }
    });
    assert.equal(calls.some(call => call.statement.includes("SET transaction_id = $1, status = 'completed'")), false,
      'ambiguous owner aliases must not claim even a matching checkout attempt');
    const ledger = calls.find(call => call.statement.includes('INSERT INTO paddle_transaction_events'));
    assert.ok(ledger);
    assert.equal(ledger.params[2], null);
    assert.ok(calls.some(call => call.statement.includes('INSERT INTO paddle_adjustment_reconciliation_cases')));
    assert.equal(calls.some(call => call.statement.includes('UPDATE users SET')), false,
      'ambiguous identity must never grant recurring or lifetime access');
  } finally {
    if (originalPriceId === undefined) delete process.env.PADDLE_PRICE_ID_1MONTH;
    else process.env.PADDLE_PRICE_ID_1MONTH = originalPriceId;
  }
});


test('transaction.canceled quarantines conflicting owner aliases without canceling or attributing an attempt', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalPriceId = process.env.PADDLE_PRICE_ID_1MONTH;
  process.env.PADDLE_PRICE_ID_1MONTH = 'pri_monthambiguouscancel';
  const ownerA = '00000000-0000-4000-8000-000000000103';
  const ownerB = '00000000-0000-4000-8000-000000000104';
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const statement = String(sql);
      calls.push({ statement, params });
      if (statement.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: params[0] }] };
      }
      if (statement.includes('SELECT DISTINCT user_id') && statement.includes('paddle_checkout_attempt_history')) {
        return { rowCount: 1, rows: [{ user_id: ownerA }] };
      }
      if (statement.includes('SET transaction_id = COALESCE(transaction_id, $1)')) {
        return { rowCount: 1, rows: [{ user_id: ownerA, plan: '1month' }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  try {
    await processPaddleEvent({ async connect() { return client; } }, {
    eventId: 'evt_ambiguous_cancel_owner',
    eventType: 'transaction.canceled',
    occurredAt: '2026-11-05T10:05:00Z',
    data: {
      id: 'txn_ambiguouscancelowner123',
      customData: {
        userId: ownerA,
        user_id: ownerB,
        plan: '1month',
        checkoutAttemptId: 'ffffffff-ffff-4fff-8fff-ffffffffffff'
      },
      items: [{ price: { id: 'pri_monthambiguouscancel' } }]
    }
  });
  assert.equal(calls.some(call => call.statement.includes('SET transaction_id = COALESCE(transaction_id, $1)')), false,
    'ambiguous identity must not mutate a checkout attempt');
  const ledger = calls.find(call => call.statement.includes('INSERT INTO paddle_transaction_events'));
  assert.ok(ledger);
  assert.equal(ledger.params[2], null,
    'a retained owner must not override contradictory signed owner aliases');
    assert.ok(calls.some(call => call.statement.includes('INSERT INTO paddle_adjustment_reconciliation_cases')));
  } finally {
    if (originalPriceId === undefined) delete process.env.PADDLE_PRICE_ID_1MONTH;
    else process.env.PADDLE_PRICE_ID_1MONTH = originalPriceId;
  }
});


test('customer.updated quarantines conflicting owner aliases instead of binding the customer to either account', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const ownerA = '00000000-0000-4000-8000-000000000105';
  const ownerB = '00000000-0000-4000-8000-000000000106';
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const statement = String(sql);
      calls.push({ statement, params });
      if (statement.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: params[0] }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  await processPaddleEvent({ async connect() { return client; } }, {
    eventId: 'evt_customer_owner_alias_conflict',
    eventType: 'customer.updated',
    occurredAt: '2026-11-05T10:10:00Z',
    data: {
      id: 'ctm_ambiguouscustomerowner123',
      email: 'member@example.test',
      customData: { userId: ownerA, user_id: ownerB, plan: '1month' }
    }
  });
  assert.equal(calls.some(call => call.statement.includes('UPDATE users SET')), false,
    'a customer event with contradictory account aliases must not bind the provider customer to either account');
  const conflict = calls.find(call => call.statement.includes('INSERT INTO paddle_adjustment_reconciliation_cases'));
  assert.ok(conflict);
  assert.equal(conflict.params[0], 'evt_customer_owner_alias_conflict');
  assert.equal(conflict.params[1], null);
  assert.equal(conflict.params[2], null,
    'neither contradictory owner alias is authoritative reconciliation context');
});


test('subscription.created with conflicting owner aliases does not mark either checkout attempt', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalPriceId = process.env.PADDLE_PRICE_ID_1MONTH;
  process.env.PADDLE_PRICE_ID_1MONTH = 'pri_month_subscription_alias_conflict';
  const ownerA = '00000000-0000-4000-8000-000000000107';
  const ownerB = '00000000-0000-4000-8000-000000000108';
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const statement = String(sql);
      calls.push({ statement, params });
      if (statement.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: params[0] }] };
      }
      if (statement.includes('SELECT id FROM users WHERE paddle_subscription_id')) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  try {
    await processPaddleEvent({ async connect() { return client; } }, {
      eventId: 'evt_subscription_owner_alias_conflict',
      eventType: 'subscription.created',
      occurredAt: '2026-11-05T11:00:00Z',
      data: {
        id: 'sub_subscriptionaliasconflict123',
        transactionId: 'txn_subscriptionaliasconflict123',
        customerId: 'ctm_subscriptionaliasconflict123',
        status: 'active',
        currentBillingPeriod: { endsAt: '2027-01-01T00:00:00Z' },
        items: [{ price: { id: 'pri_month_subscription_alias_conflict' } }],
        customData: {
          userId: ownerA,
          user_id: ownerB,
          plan: '1month',
          checkoutAttemptId: 'abababab-abab-4bab-8bab-abababababab'
        }
      }
    });
    assert.equal(calls.some(call => call.statement.includes('UPDATE paddle_checkout_attempts')), false,
      'contradictory owner aliases must not alter checkout-attempt state');
    assert.equal(calls.some(call => call.statement.includes('UPDATE users SET')), false,
      'contradictory owner aliases must not attach a subscription or grant access');
    const conflict = calls.find(call => call.statement.includes('INSERT INTO paddle_adjustment_reconciliation_cases'));
    assert.ok(conflict, 'the provider identity conflict must remain visible for reconciliation');
    assert.equal(conflict.params[2], null);
  } finally {
    if (originalPriceId === undefined) delete process.env.PADDLE_PRICE_ID_1MONTH;
    else process.env.PADDLE_PRICE_ID_1MONTH = originalPriceId;
  }
});

test('transaction.canceled does not cancel a checkout attempt owned by a different retained account', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const originalPriceId = process.env.PADDLE_PRICE_ID_1MONTH;
  process.env.PADDLE_PRICE_ID_1MONTH = 'pri_month_retained_owner_conflict';
  const retainedOwner = '00000000-0000-4000-8000-000000000109';
  const metadataOwner = '00000000-0000-4000-8000-000000000110';
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const statement = String(sql);
      calls.push({ statement, params });
      if (statement.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: params[0] }] };
      }
      if (statement.includes('SELECT DISTINCT user_id') && statement.includes('paddle_checkout_attempt_history')) {
        return { rowCount: 1, rows: [{ user_id: retainedOwner }] };
      }
      if (statement.includes('SET transaction_id = COALESCE(transaction_id, $1)')) {
        return { rowCount: 1, rows: [{ user_id: metadataOwner, plan: '1month' }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  try {
    await processPaddleEvent({ async connect() { return client; } }, {
      eventId: 'evt_cancel_retained_owner_conflict',
      eventType: 'transaction.canceled',
      occurredAt: '2026-11-05T11:10:00Z',
      data: {
        id: 'txn_cancelretainedownerconflict123',
        customData: {
          userId: metadataOwner,
          plan: '1month',
          checkoutAttemptId: 'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc'
        },
        items: [{ price: { id: 'pri_month_retained_owner_conflict' } }]
      }
    });
    assert.equal(calls.some(call => call.statement.includes('SET transaction_id = COALESCE(transaction_id, $1)')), false,
      'a retained transaction owner mismatch must be detected before mutating a checkout attempt');
    const ledger = calls.find(call => call.statement.includes('INSERT INTO paddle_transaction_events'));
    assert.ok(ledger);
    assert.equal(ledger.params[2], null,
      'a contradictory retained owner must not be attributed to the metadata account');
    const conflict = calls.find(call => call.statement.includes('INSERT INTO paddle_adjustment_reconciliation_cases'));
    assert.ok(conflict);
    assert.equal(conflict.params[2], metadataOwner);
  } finally {
    if (originalPriceId === undefined) delete process.env.PADDLE_PRICE_ID_1MONTH;
    else process.env.PADDLE_PRICE_ID_1MONTH = originalPriceId;
  }
});


test('malformed customer ID on canceled transaction retains the valid transaction ID in identity reconciliation', async () => {
  const { processPaddleEvent } = await import('./paddleBilling.js');
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const statement = String(sql);
      calls.push({ statement, params });
      if (statement.includes('INSERT INTO paddle_webhook_events')) {
        return { rowCount: 1, rows: [{ event_id: params[0] }] };
      }
      if (statement.includes('COUNT(DISTINCT user_id) > 1')) {
        return { rowCount: 1, rows: [{ ambiguous: false }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  const result = await processPaddleEvent({ async connect() { return client; } }, {
    eventId: 'evt_canceled_bad_customer_alias_conflict',
    eventType: 'transaction.canceled',
    occurredAt: '2026-11-05T12:00:00Z',
    data: {
      id: 'txn_canceledbadcustomer123',
      customerId: 'not-a-paddle-customer',
      customData: {
        userId: '00000000-0000-4000-8000-000000000111',
        user_id: '00000000-0000-4000-8000-000000000112',
        plan: '1month'
      }
    }
  });
  assert.deepEqual(result, { duplicate: false, handled: true });
  const conflict = calls.find(call => call.statement.includes('INSERT INTO paddle_adjustment_reconciliation_cases'));
  assert.ok(conflict, 'ambiguous signed owner metadata must remain in reconciliation');
  assert.equal(conflict.params[1], 'txn_canceledbadcustomer123',
    'the valid canceled transaction ID must not be discarded because customer metadata is malformed');
  assert.equal(conflict.params[2], null,
    'a contradictory owner alias pair must never be attributed to either account');
  const transactionEvidence = calls.find(call => call.statement.includes('INSERT INTO paddle_transaction_events'));
  assert.ok(transactionEvidence, 'the valid canceled transaction must remain in the immutable provider ledger');
  assert.equal(transactionEvidence.params[1], 'txn_canceledbadcustomer123');
  assert.equal(transactionEvidence.params[2], null,
    'the provider ledger must preserve the transaction without attributing it to either conflicting account');
  assert.equal(transactionEvidence.params[4], 'canceled');
  assert.equal(calls.some(call => call.statement.includes('UPDATE paddle_checkout_attempts')), false);
  assert.equal(calls.some(call => call.statement.includes('UPDATE users SET')), false);
});
