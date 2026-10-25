import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

async function findFreePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a test port');
  const { port } = address;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

test('auth API supports registration, session lookup, logout and login', {
  skip: !process.env.DATABASE_URL,
  timeout: 30_000
}, async () => {
  const port = await findFreePort();
  const origin = 'http://localhost:3000';
  const api = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env,
      API_PORT: String(port),
      APP_ORIGIN: origin,
      NODE_ENV: 'test'
    },
    stdio: 'ignore'
  });

  async function request(path, options = {}) {
    return fetch(`${api}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        Origin: origin,
        ...(options.headers || {})
      }
    });
  }

  try {
    let healthy = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`API process exited with code ${child.exitCode}`);
      try {
        const response = await fetch(`${api}/api/health`);
        if (response.ok) {
          healthy = true;
          break;
        }
      } catch {
        // The process may need a moment to bind its port.
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(healthy, true, 'API should start and answer the health check');

    const email = `test-${randomUUID()}@example.test`;
    const password = 'Test Password 2026! Secure';
    const registration = await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password,
        displayName: 'Тестовая анкета',
        birthDate: '1990-01-01',
        gender: 'female',
        country: 'Грузия',
        city: 'Тбилиси',
        relationshipIntent: 'family_without_marriage',
        familyFormat: 'cohabitation',
        hasChildren: false,
        wantsChildren: 'yes',
        childrenLivingArrangement: 'not_applicable'
      })
    });
    assert.equal(registration.status, 201);
    const registered = await registration.json();
    assert.equal(registered.user.email, email);
    assert.equal(registered.user.country, 'Грузия');
    assert.equal('password_hash' in registered.user, false);
    const firstCookie = registration.headers.get('set-cookie')?.split(';')[0];
    assert.ok(firstCookie?.startsWith('nit_session='));
    const billingStatus = await request('/api/billing/status', { headers: { Cookie: firstCookie } });
    assert.equal(billingStatus.status, 200);
    const trial = await billingStatus.json();
    assert.equal(trial.access, 'full');
    assert.equal(trial.trialActive, true);
    assert.equal(trial.paymentConfigured, false);

    const notificationList = await request('/api/notifications', { headers: { Cookie: firstCookie } });
    assert.equal(notificationList.status, 200);
    assert.deepEqual((await notificationList.json()).notifications, []);
    for (const adminPath of ['/api/admin/reports', '/api/admin/photos', '/api/admin/audit-log']) {
      const forbidden = await request(adminPath, { headers: { Cookie: firstCookie } });
      assert.equal(forbidden.status, 403);
    }

    const forbiddenModerationAction = await request(`/api/admin/reports/${randomUUID()}/action`, {
      method: 'POST',
      headers: { Cookie: firstCookie },
      body: JSON.stringify({ action: 'suspend_user', confirmed: true, reason: 'authorization regression test' })
    });
    assert.equal(forbiddenModerationAction.status, 403, 'ordinary users must not perform moderator actions');

    const selfReport = await request('/api/reports', {
      method: 'POST',
      headers: { Cookie: firstCookie },
      body: JSON.stringify({
        reportedUserId: registered.user.id,
        category: 'spam',
        details: 'A user cannot report their own account'
      })
    });
    assert.equal(selfReport.status, 400, 'users must not submit reports against themselves');

    const invalidReportCategory = await request('/api/reports', {
      method: 'POST',
      headers: { Cookie: firstCookie },
      body: JSON.stringify({
        reportedUserId: randomUUID(),
        category: 'make_admin',
        details: 'Invalid category must be rejected before target lookup'
      })
    });
    assert.equal(invalidReportCategory.status, 400, 'unknown report categories must be rejected');
    const markNotificationsRead = await request('/api/notifications/read-all', {
      method: 'POST',
      headers: { Cookie: firstCookie }
    });
    assert.equal(markNotificationsRead.status, 204);

    const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/n1sAAAAASUVORK5CYII=', 'base64');
    const photoUpload = await request('/api/photos', {
      method: 'POST',
      headers: { Cookie: firstCookie, 'Content-Type': 'image/png' },
      body: tinyPng
    });
    assert.equal(photoUpload.status, 201);
    const uploadedPhoto = await photoUpload.json();
    assert.match(uploadedPhoto.photoUrl, /^\/api\/photos\/[a-f0-9-]{36}$/i);
    const photoRead = await request(uploadedPhoto.photoUrl, { headers: { Cookie: firstCookie } });
    assert.equal(photoRead.status, 200);
    assert.equal(photoRead.headers.get('content-type'), 'image/png');


    const missingChildrenDisclosure = await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: `missing-children-${randomUUID()}@example.test`,
        password,
        displayName: 'Без ответа',
        birthDate: '1990-01-01',
        gender: 'female',
        country: 'Грузия',
        city: 'Тбилиси'
      })
    });
    assert.equal(missingChildrenDisclosure.status, 400);
    assert.equal((await missingChildrenDisclosure.json()).error, 'children_status_required');

    const underageRegistration = await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: `underage-${randomUUID()}@example.test`,
        password,
        displayName: 'Несовершеннолетний',
        birthDate: '2010-01-01',
        gender: 'female',
        country: 'Грузия',
        city: 'Тбилиси',
        relationshipIntent: 'serious_relationship',
        familyFormat: 'open_to_both',
        hasChildren: false,
        wantsChildren: 'discuss',
        childrenLivingArrangement: 'not_applicable'
      })
    });
    assert.equal(underageRegistration.status, 400);
    assert.equal((await underageRegistration.json()).error, 'must_be_18_or_older_with_valid_birth_date');

    const duplicate = await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password,
        displayName: 'Другая анкета',
        birthDate: '1990-01-01',
        gender: 'female',
        country: 'Грузия',
        city: 'Тбилиси',
        hasChildren: false
      })
    });
    assert.equal(duplicate.status, 409);

    const me = await request('/api/auth/me', { headers: { Cookie: firstCookie } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.email, email);

    const logout = await request('/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: firstCookie }
    });
    assert.equal(logout.status, 204);

    const loggedOutMe = await request('/api/auth/me', { headers: { Cookie: firstCookie } });
    assert.equal(loggedOutMe.status, 401);

    const loggedOutMatches = await request('/api/matches', { headers: { Cookie: firstCookie } });
    assert.equal(loggedOutMatches.status, 401, 'expired or logged-out sessions must not load server matches');

    const login = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    assert.equal(login.status, 200);
    const secondCookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(secondCookie?.startsWith('nit_session='));

    const maleEmail = `test-${randomUUID()}@example.test`;
    const maleRegistration = await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: maleEmail,
        password,
        displayName: 'Тестовый профиль',
        birthDate: '1990-05-10',
        gender: 'male',
        country: 'Грузия',
        city: 'Тбилиси',
        relationshipIntent: 'family_without_marriage',
        familyFormat: 'cohabitation',
        hasChildren: false,
        wantsChildren: 'yes',
        childrenLivingArrangement: 'not_applicable'
      })
    });
    assert.equal(maleRegistration.status, 201);
    const maleRegistered = await maleRegistration.json();
    const maleCookie = maleRegistration.headers.get('set-cookie')?.split(';')[0];
    assert.ok(maleCookie?.startsWith('nit_session='));

    // Exercise withdrawal against real PostgreSQL rows, not only the pure policy helper.
    // This integration case is skipped with the enclosing auth test when DATABASE_URL is absent.
    const giftTestDb = new Pool({ connectionString: process.env.DATABASE_URL });
    let giftOrderId;
    let giftMatchId;
    let giftMatchCreated = false;
    try {
      const [userA, userB] = [registered.user.id, maleRegistered.user.id].sort();
      const match = await giftTestDb.query(
        `INSERT INTO matches (user_a_id, user_b_id, status)
         VALUES ($1, $2, 'active')
         ON CONFLICT (user_a_id, user_b_id) DO NOTHING
         RETURNING id`,
        [userA, userB]
      );
      giftMatchCreated = match.rowCount === 1;
      const matchRow = match.rows[0] || (await giftTestDb.query(
        'SELECT id FROM matches WHERE user_a_id = $1 AND user_b_id = $2',
        [userA, userB]
      )).rows[0];
      if (!matchRow) throw new Error('Could not create or locate integration-test match');
      giftMatchId = matchRow.id;

      const giftOrder = await giftTestDb.query(
        `INSERT INTO gift_delivery_orders
           (match_id, sender_id, recipient_id, product_name_snapshot, product_category,
            total_minor_units, currency, status, payment_status, recipient_consent_at,
            recipient_consent_version, address_vault_ref, address_verified_at, idempotency_key)
         VALUES ($1, $2, $3, 'Integration test chocolate', 'chocolate', 1000, 'USD',
                 'address_verified', 'not_started', NOW(), 1, 'test-only-vault-reference',
                 NOW(), $4)
         RETURNING id, public_reference`,
        [giftMatchId, maleRegistered.user.id, registered.user.id, randomUUID()]
      );
      giftOrderId = giftOrder.rows[0].id;
      const giftReference = giftOrder.rows[0].public_reference;

      const crossAccountWithdrawal = await request(
        `/api/gifts/orders/${giftReference}/withdraw-consent`,
        { method: 'POST', headers: { Cookie: maleCookie } }
      );
      assert.equal(crossAccountWithdrawal.status, 404,
        'a sender or unrelated account must not withdraw the recipient\'s consent');

      const successfulWithdrawal = await request(
        `/api/gifts/orders/${giftReference}/withdraw-consent`,
        { method: 'POST', headers: { Cookie: secondCookie } }
      );
      assert.equal(successfulWithdrawal.status, 200);
      assert.deepEqual(await successfulWithdrawal.json(), {
        order: { id: giftReference, status: 'cancelled', consentWithdrawn: true }
      });

      const persistedOrder = await giftTestDb.query(
        `SELECT status, consent_withdrawn_at, address_vault_ref, address_verified_at
         FROM gift_delivery_orders WHERE id = $1`,
        [giftOrderId]
      );
      assert.equal(persistedOrder.rows[0].status, 'cancelled');
      assert.ok(persistedOrder.rows[0].consent_withdrawn_at);
      assert.equal(persistedOrder.rows[0].address_vault_ref, null);
      assert.equal(persistedOrder.rows[0].address_verified_at, null);

      const auditEvent = await giftTestDb.query(
        `SELECT event_type, actor_type, from_status, to_status
         FROM gift_delivery_order_events
         WHERE order_id = $1 AND event_type = 'consent_withdrawn'`,
        [giftOrderId]
      );
      assert.equal(auditEvent.rowCount, 1);
      assert.deepEqual(auditEvent.rows[0], {
        event_type: 'consent_withdrawn',
        actor_type: 'recipient',
        from_status: 'address_verified',
        to_status: 'cancelled'
      });

      const repeatedWithdrawal = await request(
        `/api/gifts/orders/${giftReference}/withdraw-consent`,
        { method: 'POST', headers: { Cookie: secondCookie } }
      );
      assert.equal(repeatedWithdrawal.status, 409,
        'a second withdrawal must not create another transition or audit event');

      // Race two recipient requests against a separate order. Row/advisory locks must
      // allow only one transition and exactly one consent-withdrawal audit event.
      const concurrentOrderResult = await giftTestDb.query(
        `INSERT INTO gift_delivery_orders
           (match_id, sender_id, recipient_id, product_name_snapshot, product_category,
            total_minor_units, currency, status, payment_status, recipient_consent_at,
            recipient_consent_version, address_vault_ref, address_verified_at, idempotency_key)
         VALUES ($1, $2, $3, 'Concurrent integration test chocolate', 'chocolate', 1000, 'USD',
                 'address_verified', 'not_started', NOW(), 1, 'test-only-concurrent-vault-reference',
                 NOW(), $4)
         RETURNING id, public_reference`,
        [giftMatchId, maleRegistered.user.id, registered.user.id, randomUUID()]
      );
      const concurrentGiftOrderId = concurrentOrderResult.rows[0].id;
      const concurrentGiftReference = concurrentOrderResult.rows[0].public_reference;
      try {
        const concurrentResponses = await Promise.all([
          request(`/api/gifts/orders/${concurrentGiftReference}/withdraw-consent`, {
            method: 'POST', headers: { Cookie: secondCookie }
          }),
          request(`/api/gifts/orders/${concurrentGiftReference}/withdraw-consent`, {
            method: 'POST', headers: { Cookie: secondCookie }
          })
        ]);
        assert.deepEqual(
          concurrentResponses.map(response => response.status).sort((a, b) => a - b),
          [200, 409],
          'exactly one concurrent withdrawal may win; the other must see the terminal state'
        );
        const concurrentState = await giftTestDb.query(
          `SELECT status, consent_withdrawn_at, address_vault_ref, address_verified_at
           FROM gift_delivery_orders WHERE id = $1`,
          [concurrentGiftOrderId]
        );
        assert.equal(concurrentState.rows[0].status, 'cancelled');
        assert.ok(concurrentState.rows[0].consent_withdrawn_at);
        assert.equal(concurrentState.rows[0].address_vault_ref, null);
        assert.equal(concurrentState.rows[0].address_verified_at, null);
        const concurrentAudit = await giftTestDb.query(
          `SELECT COUNT(*)::int AS count FROM gift_delivery_order_events
           WHERE order_id = $1 AND event_type = 'consent_withdrawn'`,
          [concurrentGiftOrderId]
        );
        assert.equal(concurrentAudit.rows[0].count, 1,
          'concurrent requests must not duplicate the audit event');
      } finally {
        await giftTestDb.query('DELETE FROM gift_delivery_order_events WHERE order_id = $1', [concurrentGiftOrderId]).catch(() => {});
        await giftTestDb.query('DELETE FROM gift_delivery_orders WHERE id = $1', [concurrentGiftOrderId]).catch(() => {});
      }

      // Turning off gift requests must atomically close all pending requests
      // and record a durable audit event, so a stale notification cannot be accepted later.
      const pendingPreferenceOrder = await giftTestDb.query(
        `INSERT INTO gift_delivery_orders
           (match_id, sender_id, recipient_id, product_name_snapshot, product_category,
            total_minor_units, currency, status, payment_status, idempotency_key)
         VALUES ($1, $2, $3, 'Pending preference test gift', 'chocolate', 1000, 'USD',
                 'awaiting_recipient_consent', 'not_started', $4)
         RETURNING id, public_reference`,
        [giftMatchId, maleRegistered.user.id, registered.user.id, randomUUID()]
      );
      const pendingPreferenceOrderId = pendingPreferenceOrder.rows[0].id;
      try {
        const disableGiftRequests = await request('/api/gifts/preferences', {
          method: 'PUT',
          headers: { Cookie: secondCookie },
          body: JSON.stringify({ requestsEnabled: false })
        });
        assert.equal(disableGiftRequests.status, 200);
        assert.deepEqual((await disableGiftRequests.json()).preferences, { requestsEnabled: false });

        const pendingPreferenceState = await giftTestDb.query(
          'SELECT status FROM gift_delivery_orders WHERE id = $1',
          [pendingPreferenceOrderId]
        );
        assert.equal(pendingPreferenceState.rows[0].status, 'cancelled',
          'disabling gift requests must cancel pending requests in the same transaction');
        const preferenceAudit = await giftTestDb.query(
          `SELECT actor_type, event_type, from_status, to_status
           FROM gift_delivery_order_events WHERE order_id = $1`,
          [pendingPreferenceOrderId]
        );
        assert.deepEqual(preferenceAudit.rows, [{
          actor_type: 'recipient',
          event_type: 'cancelled',
          from_status: 'awaiting_recipient_consent',
          to_status: 'cancelled'
        }]);
        const staleAccept = await request(
          `/api/gifts/orders/${pendingPreferenceOrder.rows[0].public_reference}/decision`,
          {
            method: 'POST',
            headers: { Cookie: secondCookie },
            body: JSON.stringify({ action: 'accept' })
          }
        );
        assert.equal(staleAccept.status, 409,
          'a stale gift request cannot be accepted after the recipient disables requests');
      } finally {
        await giftTestDb.query('DELETE FROM gift_delivery_order_events WHERE order_id = $1', [pendingPreferenceOrderId]).catch(() => {});
        await giftTestDb.query('DELETE FROM gift_delivery_orders WHERE id = $1', [pendingPreferenceOrderId]).catch(() => {});
      }

      // Race opt-out against recipient acceptance. The order lock serializes the
      // operations: either acceptance commits first and remains accepted, or
      // opt-out cancels the pending request and acceptance is rejected.
      const enableGiftRequests = await request('/api/gifts/preferences', {
        method: 'PUT',
        headers: { Cookie: secondCookie },
        body: JSON.stringify({ requestsEnabled: true })
      });
      assert.equal(enableGiftRequests.status, 200);

      // Active payment states must not be silently declined or cancelled.
      // Gift payment processing is not integrated, so these requests stay
      // pending for explicit reconciliation rather than faking a void/refund.
      const activePaymentOrder = await giftTestDb.query(
        `INSERT INTO gift_delivery_orders
           (match_id, sender_id, recipient_id, product_name_snapshot, product_category,
            total_minor_units, currency, status, payment_status, idempotency_key)
         VALUES ($1, $2, $3, 'Active payment guard test gift', 'chocolate', 1000, 'USD',
                 'awaiting_recipient_consent', 'authorized', $4)
         RETURNING id, public_reference`,
        [giftMatchId, maleRegistered.user.id, registered.user.id, randomUUID()]
      );
      const activePaymentOrderId = activePaymentOrder.rows[0].id;
      const activePaymentReference = activePaymentOrder.rows[0].public_reference;
      try {
        const declineActivePayment = await request(
          `/api/gifts/orders/${activePaymentReference}/decision`,
          {
            method: 'POST',
            headers: { Cookie: secondCookie },
            body: JSON.stringify({ action: 'decline' })
          }
        );
        assert.equal(declineActivePayment.status, 409);
        assert.deepEqual(await declineActivePayment.json(), {
          error: 'gift_payment_requires_reconciliation'
        });

        await giftTestDb.query(
          'UPDATE gift_delivery_orders SET expires_at = NOW() - INTERVAL \'1 minute\' WHERE id = $1',
          [activePaymentOrderId]
        );
        const expireActivePayment = await request(
          `/api/gifts/orders/${activePaymentReference}/decision`,
          {
            method: 'POST',
            headers: { Cookie: secondCookie },
            body: JSON.stringify({ action: 'decline' })
          }
        );
        assert.equal(expireActivePayment.status, 409);
        assert.deepEqual(await expireActivePayment.json(), {
          error: 'gift_payment_requires_reconciliation'
        });
        const afterExpiryGuard = await giftTestDb.query(
          'SELECT status, payment_status FROM gift_delivery_orders WHERE id = $1',
          [activePaymentOrderId]
        );
        assert.deepEqual(afterExpiryGuard.rows[0], {
          status: 'awaiting_recipient_consent',
          payment_status: 'authorized'
        }, 'expiry must not silently abandon an active payment');

        const optOutWithActivePayment = await request('/api/gifts/preferences', {
          method: 'PUT',
          headers: { Cookie: secondCookie },
          body: JSON.stringify({ requestsEnabled: false })
        });
        assert.equal(optOutWithActivePayment.status, 200);
        const activePaymentState = await giftTestDb.query(
          'SELECT status, payment_status FROM gift_delivery_orders WHERE id = $1',
          [activePaymentOrderId]
        );
        assert.deepEqual(activePaymentState.rows[0], {
          status: 'awaiting_recipient_consent',
          payment_status: 'authorized'
        });
        const activePaymentAudit = await giftTestDb.query(
          `SELECT event_type FROM gift_delivery_order_events WHERE order_id = $1`,
          [activePaymentOrderId]
        );
        assert.deepEqual(activePaymentAudit.rows, [],
          'no cancellation event should be recorded when active payment requires reconciliation');
      } finally {
        await giftTestDb.query('DELETE FROM gift_delivery_order_events WHERE order_id = $1', [activePaymentOrderId]).catch(() => {});
        await giftTestDb.query('DELETE FROM gift_delivery_orders WHERE id = $1', [activePaymentOrderId]).catch(() => {});
      }

      const reenableAfterActivePayment = await request('/api/gifts/preferences', {
        method: 'PUT',
        headers: { Cookie: secondCookie },
        body: JSON.stringify({ requestsEnabled: true })
      });
      assert.equal(reenableAfterActivePayment.status, 200);

      const raceOrderResult = await giftTestDb.query(
        `INSERT INTO gift_delivery_orders
           (match_id, sender_id, recipient_id, product_name_snapshot, product_category,
            total_minor_units, currency, status, payment_status, idempotency_key)
         VALUES ($1, $2, $3, 'Opt-out race test gift', 'chocolate', 1000, 'USD',
                 'awaiting_recipient_consent', 'not_started', $4)
         RETURNING id, public_reference`,
        [giftMatchId, maleRegistered.user.id, registered.user.id, randomUUID()]
      );
      const raceOrderId = raceOrderResult.rows[0].id;
      const raceReference = raceOrderResult.rows[0].public_reference;
      try {
        const [raceDecision, raceOptOut] = await Promise.all([
          request(`/api/gifts/orders/${raceReference}/decision`, {
            method: 'POST',
            headers: { Cookie: secondCookie },
            body: JSON.stringify({ action: 'accept' })
          }),
          request('/api/gifts/preferences', {
            method: 'PUT',
            headers: { Cookie: secondCookie },
            body: JSON.stringify({ requestsEnabled: false })
          })
        ]);
        assert.equal(raceOptOut.status, 200);
        assert.ok([200, 409].includes(raceDecision.status),
          'concurrent acceptance must either commit before opt-out or be rejected after cancellation');
        const raceState = await giftTestDb.query(
          'SELECT status FROM gift_delivery_orders WHERE id = $1',
          [raceOrderId]
        );
        assert.ok(['cancelled', 'recipient_accepted'].includes(raceState.rows[0].status));
        if (raceDecision.status === 200) {
          assert.equal(raceState.rows[0].status, 'recipient_accepted',
            'if acceptance wins the order lock, the accepted order remains accepted');
        } else {
          assert.equal(raceState.rows[0].status, 'cancelled',
            'if opt-out wins the order lock, acceptance must not revive the cancelled request');
        }
        const raceAudit = await giftTestDb.query(
          `SELECT event_type, from_status, to_status
           FROM gift_delivery_order_events WHERE order_id = $1 ORDER BY created_at, id`,
          [raceOrderId]
        );
        assert.equal(raceAudit.rowCount, 1,
          'the winning state transition must produce exactly one audit event');
        assert.ok(
          (raceState.rows[0].status === 'cancelled' && raceAudit.rows[0].event_type === 'cancelled') ||
          (raceState.rows[0].status === 'recipient_accepted' && raceAudit.rows[0].event_type === 'accepted')
        );
      } finally {
        await giftTestDb.query('DELETE FROM gift_delivery_order_events WHERE order_id = $1', [raceOrderId]).catch(() => {});
        await giftTestDb.query('DELETE FROM gift_delivery_orders WHERE id = $1', [raceOrderId]).catch(() => {});
      }

      // Disabling future requests must not silently withdraw consent already
      // given for an accepted order.
      const acceptedOrderResult = await giftTestDb.query(
        `INSERT INTO gift_delivery_orders
           (match_id, sender_id, recipient_id, product_name_snapshot, product_category,
            total_minor_units, currency, status, payment_status, recipient_consent_at,
            recipient_consent_version, idempotency_key)
         VALUES ($1, $2, $3, 'Accepted consent preservation test', 'chocolate', 1000, 'USD',
                 'recipient_accepted', 'not_started', NOW(), 1, $4)
         RETURNING id`,
        [giftMatchId, maleRegistered.user.id, registered.user.id, randomUUID()]
      );
      const acceptedOrderId = acceptedOrderResult.rows[0].id;
      await giftTestDb.query(
        `INSERT INTO gift_delivery_order_events
           (order_id, actor_user_id, actor_type, event_type, from_status, to_status)
         VALUES ($1, $2, 'recipient', 'accepted', 'awaiting_recipient_consent', 'recipient_accepted')`,
        [acceptedOrderId, registered.user.id]
      );
      try {
        const disableFutureRequests = await request('/api/gifts/preferences', {
          method: 'PUT',
          headers: { Cookie: secondCookie },
          body: JSON.stringify({ requestsEnabled: false })
        });
        assert.equal(disableFutureRequests.status, 200);
        const acceptedState = await giftTestDb.query(
          'SELECT status, recipient_consent_at FROM gift_delivery_orders WHERE id = $1',
          [acceptedOrderId]
        );
        assert.equal(acceptedState.rows[0].status, 'recipient_accepted');
        assert.ok(acceptedState.rows[0].recipient_consent_at,
          'previously recorded per-order consent must remain intact');
        const acceptedAudit = await giftTestDb.query(
          'SELECT event_type, from_status, to_status FROM gift_delivery_order_events WHERE order_id = $1',
          [acceptedOrderId]
        );
        assert.deepEqual(acceptedAudit.rows, [{
          event_type: 'accepted',
          from_status: 'awaiting_recipient_consent',
          to_status: 'recipient_accepted'
        }], 'opting out of future requests must preserve the existing consent audit event without adding cancellation');
      } finally {
        await giftTestDb.query('DELETE FROM gift_delivery_order_events WHERE order_id = $1', [acceptedOrderId]).catch(() => {});
        await giftTestDb.query('DELETE FROM gift_delivery_orders WHERE id = $1', [acceptedOrderId]).catch(() => {});
      }
    } finally {
      if (giftOrderId) {
        await giftTestDb.query('DELETE FROM gift_delivery_order_events WHERE order_id = $1', [giftOrderId]).catch(() => {});
        await giftTestDb.query('DELETE FROM gift_delivery_orders WHERE id = $1', [giftOrderId]).catch(() => {});
      }
      if (giftMatchId && giftMatchCreated) {
        await giftTestDb.query('DELETE FROM matches WHERE id = $1', [giftMatchId]).catch(() => {});
      }
      await giftTestDb.end();
    }

    const unauthenticatedAdConsentRead = await request('/api/ads/consent');
    assert.equal(unauthenticatedAdConsentRead.status, 401,
      'advertising preferences must never be readable without an authenticated session');

    const unauthenticatedGiftConsentWithdrawal = await request('/api/gifts/orders/gift_0123456789abcdef0123456789abcdef/withdraw-consent', {
      method: 'POST'
    });
    assert.equal(unauthenticatedGiftConsentWithdrawal.status, 401,
      'gift consent withdrawal must require an authenticated recipient session');

    const invalidGiftReference = await request('/api/gifts/orders/not-a-gift-reference/withdraw-consent', {
      method: 'POST',
      headers: { Cookie: secondCookie }
    });
    assert.equal(invalidGiftReference.status, 400,
      'gift consent withdrawal must reject malformed public references before querying orders');

    const unauthenticatedAdConsentWrite = await request('/api/ads/consent', {
      method: 'PUT',
      body: JSON.stringify({
        adsConsent: true,
        dateOffersConsent: false,
        weddingOffersConsent: false,
        marriagePlanningOptIn: false,
        categoryConsents: {}
      })
    });
    assert.equal(unauthenticatedAdConsentWrite.status, 401,
      'advertising preferences must never be writable without an authenticated session');

    const originlessAdConsentWrite = await fetch(`${api}/api/ads/consent`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: secondCookie },
      body: JSON.stringify({
        adsConsent: true,
        dateOffersConsent: false,
        weddingOffersConsent: false,
        marriagePlanningOptIn: false,
        categoryConsents: {}
      })
    });
    assert.equal(originlessAdConsentWrite.status, 403,
      'browser-originated consent changes must reject requests without an explicit trusted Origin');

    const initialAdConsent = await request('/api/ads/consent', { headers: { Cookie: secondCookie } });
    assert.equal(initialAdConsent.status, 200);
    assert.deepEqual((await initialAdConsent.json()).preferences, {
      adsConsent: false,
      dateOffersConsent: false,
      weddingOffersConsent: false,
      marriagePlanningOptIn: false,
      categoryConsents: {}
    });

    const preConsentAdEventId = randomUUID();
    const preConsentAdEvent = await request('/api/ads/events', {
      method: 'POST',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({ eventId: preConsentAdEventId, campaignId: 'consent-gate-test', eventType: 'impression' })
    });
    assert.equal(preConsentAdEvent.status, 403,
      'an ad event must be rejected until persisted explicit consent exists');

    const savedAdConsent = await request('/api/ads/consent', {
      method: 'PUT',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({
        adsConsent: true,
        dateOffersConsent: true,
        weddingOffersConsent: true,
        marriagePlanningOptIn: true,
        categoryConsents: { travel: true, fashion: true }
      })
    });
    assert.equal(savedAdConsent.status, 200);
    assert.deepEqual((await savedAdConsent.json()).preferences, {
      adsConsent: true,
      dateOffersConsent: true,
      weddingOffersConsent: true,
      marriagePlanningOptIn: true,
      categoryConsents: { travel: true, fashion: true }
    });

    const consentedAdEventId = randomUUID();
    const consentedAdEventPayload = {
      eventId: consentedAdEventId,
      campaignId: 'consent-gate-test',
      eventType: 'impression'
    };
    const consentedAdEvent = await request('/api/ads/events', {
      method: 'POST',
      headers: { Cookie: secondCookie },
      body: JSON.stringify(consentedAdEventPayload)
    });
    assert.equal(consentedAdEvent.status, 201);
    assert.deepEqual(await consentedAdEvent.json(), { accepted: true, duplicate: false });
    const replayedAdEvent = await request('/api/ads/events', {
      method: 'POST',
      headers: { Cookie: secondCookie },
      body: JSON.stringify(consentedAdEventPayload)
    });
    assert.equal(replayedAdEvent.status, 200);
    assert.deepEqual(await replayedAdEvent.json(), { accepted: true, duplicate: true },
      'same-user same-payload retries must be idempotent');

    const foreignTargetAttempt = await request('/api/ads/consent', {
      method: 'PUT',
      headers: { Cookie: maleCookie },
      body: JSON.stringify({
        userId: registered.user.id,
        adsConsent: true,
        dateOffersConsent: true,
        weddingOffersConsent: false,
        marriagePlanningOptIn: false,
        categoryConsents: {}
      })
    });
    assert.equal(foreignTargetAttempt.status, 400,
      'the consent API must reject client-supplied user IDs rather than permitting cross-account writes');

    const outsiderAdConsent = await request('/api/ads/consent', { headers: { Cookie: maleCookie } });
    assert.equal(outsiderAdConsent.status, 200);
    assert.deepEqual((await outsiderAdConsent.json()).preferences, {
      adsConsent: false,
      dateOffersConsent: false,
      weddingOffersConsent: false,
      marriagePlanningOptIn: false,
      categoryConsents: {}
    }, 'a separate account must not read another account\'s consent preferences');

    const revokeAdConsent = await request('/api/ads/consent', {
      method: 'PUT',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({
        adsConsent: false,
        dateOffersConsent: true,
        weddingOffersConsent: true,
        marriagePlanningOptIn: true,
        categoryConsents: { travel: true, fashion: true }
      })
    });
    assert.equal(revokeAdConsent.status, 200);
    assert.deepEqual((await revokeAdConsent.json()).preferences, {
      adsConsent: false,
      dateOffersConsent: false,
      weddingOffersConsent: false,
      marriagePlanningOptIn: false,
      categoryConsents: {}
    }, 'revoking master consent must clear every dependent preference in persisted API state');

    const postRevocationAdEvent = await request('/api/ads/events', {
      method: 'POST',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({
        eventId: randomUUID(),
        campaignId: 'consent-gate-test',
        eventType: 'click'
      })
    });
    assert.equal(postRevocationAdEvent.status, 403,
      'revoking persisted master consent must immediately block new ad engagement events');

    const pendingPhotoReadByOtherAccount = await request(uploadedPhoto.photoUrl, { headers: { Cookie: maleCookie } });
    assert.equal(pendingPhotoReadByOtherAccount.status, 404, 'pending photos must not be visible to other accounts');
    const crossAccountPhotoAttach = await request('/api/profiles/me', {
      method: 'PATCH',
      headers: { Cookie: maleCookie },
      body: JSON.stringify({ photoUrls: [uploadedPhoto.photoUrl] })
    });
    assert.equal(crossAccountPhotoAttach.status, 400);
    const duplicatePhotoReferences = await request('/api/profiles/me', {
      method: 'PATCH',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({ photoUrls: [uploadedPhoto.photoUrl, uploadedPhoto.photoUrl] })
    });
    assert.equal(duplicatePhotoReferences.status, 400, 'the same private photo cannot be attached more than once');

    const removePhoto = await request('/api/profiles/me', {
      method: 'PATCH',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({ photoUrls: [] })
    });
    assert.equal(removePhoto.status, 200);
    const removedPhotoRead = await request(uploadedPhoto.photoUrl, { headers: { Cookie: secondCookie } });
    assert.equal(removedPhotoRead.status, 404);
    const assessmentAnswers = {
      relationshipGoal: 'marriage_soon',
      children: 'want_soon',
      financialModel: 'shared_equal',
      lifestyleExpectation: 'balanced',
      gifts: 'medium',
      household: 'equal',
      fidelity: 'strict',
      conflictStyle: 'talk_soon',
      honesty: 'essential',
      trustRepair: 'accountability_actions',
      conflictSafety: 'no_insults_control',
      debtTransparency: 'open_before_commitment',
      substanceLifestyle: 'occasional_social',
      relocation: 'depends_on_plan',
      caregiving: 'shared_care'
    };
    const incompleteAssessment = await request('/api/assessment', {
      method: 'PUT',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({ answers: { financialModel: 'provider_full' } })
    });
    assert.equal(incompleteAssessment.status, 400);

    const savedFemaleAssessment = await request('/api/assessment', {
      method: 'PUT',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({ answers: assessmentAnswers })
    });
    assert.equal(savedFemaleAssessment.status, 200);
    const savedMaleAssessment = await request('/api/assessment', {
      method: 'PUT',
      headers: { Cookie: maleCookie },
      body: JSON.stringify({ answers: assessmentAnswers })
    });
    assert.equal(savedMaleAssessment.status, 200);

    const assessmentRead = await request('/api/assessment', { headers: { Cookie: secondCookie } });
    assert.equal(assessmentRead.status, 200);
    assert.equal((await assessmentRead.json()).assessment.answers.financialModel, 'shared_equal');

    const search = await request('/api/profiles/search?minAge=36&maxAge=36&minFinancialAlignment=100&country=' + encodeURIComponent('грузия') + '&city=' + encodeURIComponent('тбилиси'), {
      headers: { Cookie: secondCookie }
    });
    assert.equal(search.status, 200);
    const searchResult = await search.json();
    assert.equal(searchResult.profiles.some(profile => profile.id === registered.user.id), false);
    assert.equal(searchResult.profiles.some(profile => profile.displayName === 'Тестовый профиль' && profile.gender === 'male'), true);

    const wrongLocation = await request('/api/profiles/search?country=' + encodeURIComponent('Россия'), {
      headers: { Cookie: secondCookie }
    });
    assert.equal(wrongLocation.status, 200);
    assert.equal((await wrongLocation.json()).profiles.length, 0);

    const unauthenticatedSearch = await request('/api/profiles/search');
    assert.equal(unauthenticatedSearch.status, 401);

    const undoTargetPass = await request('/api/passes/' + registered.user.id, {
      method: 'POST',
      headers: { Cookie: maleCookie }
    });
    assert.equal(undoTargetPass.status, 204);
    const undoMostRecentPass = await request('/api/passes/undo', {
      method: 'POST',
      headers: { Cookie: maleCookie },
      body: JSON.stringify({ targetId: registered.user.id })
    });
    assert.equal(undoMostRecentPass.status, 200);
    assert.equal((await undoMostRecentPass.json()).profile.id, registered.user.id);
    const afterTargetedUndoSearch = await request('/api/profiles/search', { headers: { Cookie: maleCookie } });
    assert.equal((await afterTargetedUndoSearch.json()).profiles.some(profile => profile.id === registered.user.id), true);
    const undoNoPass = await request('/api/passes/undo', {
      method: 'POST',
      headers: { Cookie: maleCookie }
    });
    assert.equal(undoNoPass.status, 404);

    // A stale or manually crafted request must not like a profile that is still passed.
    const passAgain = await request(`/api/passes/${registered.user.id}`, {
      method: 'POST',
      headers: { Cookie: maleCookie },
      body: JSON.stringify({})
    });
    assert.equal(passAgain.status, 204);
    const likePassedProfile = await request(`/api/likes/${registered.user.id}`, {
      method: 'POST',
      headers: { Cookie: maleCookie },
      body: JSON.stringify({})
    });
    assert.equal(likePassedProfile.status, 404, 'a passed profile cannot be liked through a stale or direct API request');
    const undoPassAgain = await request('/api/passes/undo', {
      method: 'POST',
      headers: { Cookie: maleCookie },
      body: JSON.stringify({ targetId: registered.user.id })
    });
    assert.equal(undoPassAgain.status, 200);

    const passForReloadUndo = await request(`/api/passes/${registered.user.id}`, {
      method: 'POST',
      headers: { Cookie: maleCookie },
      body: JSON.stringify({})
    });
    assert.equal(passForReloadUndo.status, 204);
    const persistedPassUndo = await request('/api/discovery/undo', {
      method: 'POST',
      headers: { Cookie: maleCookie },
      body: JSON.stringify({})
    });
    assert.equal(persistedPassUndo.status, 200);
    assert.equal((await persistedPassUndo.json()).type, 'pass');

    const firstLike = await request(`/api/likes/${maleRegistered.user.id}`, {
      method: 'POST',
      headers: { Cookie: secondCookie }
    });
    assert.equal(firstLike.status, 201);
    assert.equal((await firstLike.json()).matched, false);

    const afterLikeSearch = await request('/api/profiles/search', { headers: { Cookie: secondCookie } });
    assert.equal((await afterLikeSearch.json()).profiles.some(profile => profile.id === maleRegistered.user.id), false,
      'profiles already liked by the current user must not be repeated in discovery');

    const undoLike = await request(`/api/likes/${maleRegistered.user.id}`, {
      method: 'DELETE',
      headers: { Cookie: secondCookie }
    });
    assert.equal(undoLike.status, 204);
    const undoLikeAgain = await request(`/api/likes/${maleRegistered.user.id}`, {
      method: 'DELETE',
      headers: { Cookie: secondCookie }
    });
    assert.equal(undoLikeAgain.status, 404, 'undo must report when there is no like to remove');
    const afterUndoLikeSearch = await request('/api/profiles/search', { headers: { Cookie: secondCookie } });
    assert.equal((await afterUndoLikeSearch.json()).profiles.some(profile => profile.id === maleRegistered.user.id), true,
      'undoing a like makes the profile eligible for discovery again');

    const firstLikeAgain = await request(`/api/likes/${maleRegistered.user.id}`, {
      method: 'POST',
      headers: { Cookie: secondCookie }
    });
    assert.equal(firstLikeAgain.status, 201);
    assert.equal((await firstLikeAgain.json()).matched, false);

    const persistedLikeUndo = await request('/api/discovery/undo', {
      method: 'POST',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({})
    });
    assert.equal(persistedLikeUndo.status, 200);
    const persistedLikeUndoPayload = await persistedLikeUndo.json();
    assert.equal(persistedLikeUndoPayload.type, 'like');
    assert.equal(persistedLikeUndoPayload.profile.id, maleRegistered.user.id);

    const firstLikeThird = await request(`/api/likes/${maleRegistered.user.id}`, {
      method: 'POST',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({})
    });
    assert.equal(firstLikeThird.status, 201);

    const reciprocalLike = await request(`/api/likes/${registered.user.id}`, {
      method: 'POST',
      headers: { Cookie: maleCookie }
    });
    assert.equal(reciprocalLike.status, 201);
    const matchPayload = await reciprocalLike.json();
    assert.equal(matchPayload.matched, true);
    assert.ok(matchPayload.match.id);

    // Repeating the reciprocal like must return the existing match, not create a duplicate.
    const repeatedReciprocalLike = await request(`/api/likes/${registered.user.id}`, {
      method: 'POST',
      headers: { Cookie: maleCookie }
    });
    assert.equal(repeatedReciprocalLike.status, 201);
    const repeatedMatchPayload = await repeatedReciprocalLike.json();
    assert.equal(repeatedMatchPayload.matched, true);
    assert.equal(repeatedMatchPayload.match.id, matchPayload.match.id,
      'repeated reciprocal likes must preserve the original match id');

    const cannotUndoMatchedLike = await request(`/api/likes/${maleRegistered.user.id}`, {
      method: 'DELETE',
      headers: { Cookie: secondCookie }
    });
    assert.equal(cannotUndoMatchedLike.status, 409, 'an active mutual match must not be silently broken by undo');
    const cannotUndoMatchedLikeAfterReload = await request('/api/discovery/undo', {
      method: 'POST',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({})
    });
    assert.equal(cannotUndoMatchedLikeAfterReload.status, 409, 'the unified undo endpoint must also preserve active matches');

    const cannotPassMatchedProfile = await request(`/api/passes/${maleRegistered.user.id}`, {
      method: 'POST',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({})
    });
    assert.equal(cannotPassMatchedProfile.status, 404, 'matched profiles cannot be passed from a stale discovery card');

    const femaleMatches = await request('/api/matches', { headers: { Cookie: secondCookie } });
    assert.equal(femaleMatches.status, 200);
    assert.equal((await femaleMatches.json()).matches.some(match => match.id === matchPayload.match.id), true);

    const outsiderRegistration = await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: `outsider-${randomUUID()}@example.test`,
        password,
        displayName: 'Посторонний пользователь',
        birthDate: '1992-03-15',
        gender: 'female',
        country: 'Грузия',
        city: 'Батуми',
        relationshipIntent: 'serious_relationship',
        familyFormat: 'open_to_both',
        hasChildren: false,
        wantsChildren: 'discuss',
        childrenLivingArrangement: 'not_applicable'
      })
    });
    assert.equal(outsiderRegistration.status, 201);
    const outsiderCookie = outsiderRegistration.headers.get('set-cookie')?.split(';')[0];
    assert.ok(outsiderCookie?.startsWith('nit_session='));

    const outsiderReadMessages = await request(`/api/matches/${matchPayload.match.id}/messages`, {
      headers: { Cookie: outsiderCookie }
    });
    assert.equal(outsiderReadMessages.status, 404, 'a non-participant must not read another pair\'s conversation');

    const outsiderSendMessage = await request(`/api/matches/${matchPayload.match.id}/messages`, {
      method: 'POST',
      headers: { Cookie: outsiderCookie },
      body: JSON.stringify({ text: 'Попытка написать в чужой чат' })
    });
    assert.equal(outsiderSendMessage.status, 404, 'a non-participant must not send messages to another pair\'s conversation');

    const sendMessage = await request(`/api/matches/${matchPayload.match.id}/messages`, {
      method: 'POST',
      headers: { Cookie: maleCookie },
      body: JSON.stringify({ text: 'Здравствуйте! Рад нашему совпадению.' })
    });
    assert.equal(sendMessage.status, 201);
    const sentMessage = (await sendMessage.json()).message;
    assert.equal(sentMessage.text, 'Здравствуйте! Рад нашему совпадению.');

    const readMessages = await request(`/api/matches/${matchPayload.match.id}/messages`, {
      headers: { Cookie: secondCookie }
    });
    assert.equal(readMessages.status, 200);
    assert.equal((await readMessages.json()).messages.some(message => message.id === sentMessage.id), true);

    const noSessionMessages = await request(`/api/matches/${matchPayload.match.id}/messages`);
    assert.equal(noSessionMessages.status, 401);

    const report = await request('/api/reports', {
      method: 'POST',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({
        reportedUserId: maleRegistered.user.id,
        category: 'other',
        details: 'Тестовая жалоба из интеграционного теста'
      })
    });
    assert.equal(report.status, 201);

    const profileUpdate = await request('/api/profiles/me', {
      method: 'PATCH',
      headers: { Cookie: maleCookie },
      body: JSON.stringify({
        bio: 'Ищу серьёзные отношения',
        occupation: 'Инженер',
        education: 'Высшее',
        languages: ['Русский', 'Английский'],
        hasChildren: true,
        familyFormat: 'cohabitation',
        wantsChildren: 'no',
        childrenLivingArrangement: 'with_me'
      })
    });
    assert.equal(profileUpdate.status, 200);
    const updatedProfile = (await profileUpdate.json()).profile;
    assert.equal(updatedProfile.occupation, 'Инженер');
    assert.deepEqual(updatedProfile.languages, ['Русский', 'Английский']);
    assert.equal(updatedProfile.hasChildren, true);
    assert.equal(updatedProfile.familyFormat, 'cohabitation');
    assert.equal(updatedProfile.wantsChildren, 'no');
    assert.ok(updatedProfile.childrenDisclosureConfirmedAt);

    const invalidPhotoUrl = await request('/api/profiles/me', {
      method: 'PATCH',
      headers: { Cookie: maleCookie },
      body: JSON.stringify({ photoUrls: ['https://images.example.test/profile.jpg'] })
    });
    assert.equal(invalidPhotoUrl.status, 400);

    const familySearch = await request('/api/profiles/search?hasChildren=true&familyFormat=cohabitation&intent=family_without_marriage', {
      headers: { Cookie: secondCookie }
    });
    assert.equal(familySearch.status, 200);
    assert.equal((await familySearch.json()).profiles.some(profile => profile.id === maleRegistered.user.id), false);

    // A block/report must also suspend already accepted, pre-dispatch gift orders
    // and clear address-vault references, not just close pending consent requests.
    const giftSafetyDb = new Pool({ connectionString: process.env.DATABASE_URL });
    let blockSafetyOrderId;
    let reportSafetyOrderId;
    let reportId;
    try {
      const safetyMatch = await giftSafetyDb.query(
        'SELECT id FROM matches WHERE id = $1',
        [matchPayload.match.id]
      );
      assert.equal(safetyMatch.rowCount, 1);
      const blockSafetyOrder = await giftSafetyDb.query(
        `INSERT INTO gift_delivery_orders
           (match_id, sender_id, recipient_id, product_name_snapshot, product_category,
            total_minor_units, currency, status, payment_status, recipient_consent_at,
            recipient_consent_version, address_vault_ref, address_verified_at, idempotency_key)
         VALUES ($1, $2, $3, 'Block safety test chocolate', 'chocolate', 1000, 'USD',
                 'address_verified', 'authorized', NOW(), 1, 'test-block-vault-reference',
                 NOW(), $4)
         RETURNING id`,
        [matchPayload.match.id, maleRegistered.user.id, registered.user.id, randomUUID()]
      );
      blockSafetyOrderId = blockSafetyOrder.rows[0].id;

      const block = await request(`/api/blocks/${maleRegistered.user.id}`, {
        method: 'POST', headers: { Cookie: secondCookie }, body: JSON.stringify({})
      });
      assert.equal(block.status, 204);
      const blockedGift = await giftSafetyDb.query(
        'SELECT status, payment_status, address_vault_ref, address_verified_at FROM gift_delivery_orders WHERE id = $1',
        [blockSafetyOrderId]
      );
      assert.equal(blockedGift.rows[0].status, 'blocked');
      assert.equal(blockedGift.rows[0].payment_status, 'authorized', 'block must not pretend an active authorization was voided');
      assert.equal(blockedGift.rows[0].address_vault_ref, null);
      assert.equal(blockedGift.rows[0].address_verified_at, null);
      const blockAudit = await giftSafetyDb.query(
        `SELECT from_status, to_status FROM gift_delivery_order_events
         WHERE order_id = $1 AND event_type = 'blocked'`,
        [blockSafetyOrderId]
      );
      assert.deepEqual(blockAudit.rows, [{ from_status: 'address_verified', to_status: 'blocked' }]);

      const reportSafetyOrder = await giftSafetyDb.query(
        `INSERT INTO gift_delivery_orders
           (match_id, sender_id, recipient_id, product_name_snapshot, product_category,
            total_minor_units, currency, status, payment_status, recipient_consent_at,
            recipient_consent_version, address_vault_ref, address_verified_at, idempotency_key)
         VALUES ($1, $2, $3, 'Report safety test chocolate', 'chocolate', 1000, 'USD',
                 'address_verified', 'captured', NOW(), 1, 'test-report-vault-reference',
                 NOW(), $4)
         RETURNING id`,
        [matchPayload.match.id, maleRegistered.user.id, registered.user.id, randomUUID()]
      );
      reportSafetyOrderId = reportSafetyOrder.rows[0].id;
      const report = await request('/api/reports', {
        method: 'POST',
        headers: { Cookie: secondCookie },
        body: JSON.stringify({
          reportedUserId: maleRegistered.user.id,
          category: 'safety',
          details: 'Integration test: suspend accepted gift'
        })
      });
      assert.equal(report.status, 201);
      reportId = (await report.json()).report.id;
      const reportedGift = await giftSafetyDb.query(
        'SELECT status, payment_status, address_vault_ref, address_verified_at FROM gift_delivery_orders WHERE id = $1',
        [reportSafetyOrderId]
      );
      assert.equal(reportedGift.rows[0].status, 'reported');
      assert.equal(reportedGift.rows[0].payment_status, 'captured', 'report must not pretend a captured payment was refunded');
      assert.equal(reportedGift.rows[0].address_vault_ref, null);
      assert.equal(reportedGift.rows[0].address_verified_at, null);
      const reportAudit = await giftSafetyDb.query(
        `SELECT from_status, to_status FROM gift_delivery_order_events
         WHERE order_id = $1 AND event_type = 'reported'`,
        [reportSafetyOrderId]
      );
      assert.deepEqual(reportAudit.rows, [{ from_status: 'address_verified', to_status: 'reported' }]);

      // Run the dispatched-block case before moderator suspension makes the
      // target account unavailable; the block endpoint must still quarantine
      // the dispatched order and clear address metadata.
      const dispatchedBlockSafetyOrder = await giftSafetyDb.query(
        `INSERT INTO gift_delivery_orders
           (match_id, sender_id, recipient_id, product_name_snapshot, product_category,
            total_minor_units, currency, status, payment_status, recipient_consent_at,
            recipient_consent_version, address_vault_ref, address_verified_at,
            fulfilment_authorized_at, dispatched_at, idempotency_key)
         VALUES ($1, $2, $3, 'Dispatched block safety test chocolate', 'chocolate', 1200, 'USD',
                 'dispatched', 'captured', NOW(), 1, 'test-dispatched-block-vault-reference',
                 NOW(), NOW(), NOW(), $4)
         RETURNING id`,
        [matchPayload.match.id, maleRegistered.user.id, registered.user.id, randomUUID()]
      );
      const dispatchedBlockSafetyOrderId = dispatchedBlockSafetyOrder.rows[0].id;
      try {
        const blockAfterDispatch = await request(`/api/blocks/${maleRegistered.user.id}`, {
          method: 'POST',
          headers: { Cookie: secondCookie },
          body: JSON.stringify({})
        });
        assert.equal(blockAfterDispatch.status, 204);
        const blockedDispatchedGift = await giftSafetyDb.query(
          'SELECT status, payment_status, address_vault_ref, address_verified_at FROM gift_delivery_orders WHERE id = $1',
          [dispatchedBlockSafetyOrderId]
        );
        assert.equal(blockedDispatchedGift.rows[0].status, 'reported');
        assert.equal(blockedDispatchedGift.rows[0].payment_status, 'captured',
          'blocking after dispatch must not pretend a captured payment was refunded');
        assert.equal(blockedDispatchedGift.rows[0].address_vault_ref, null);
        assert.equal(blockedDispatchedGift.rows[0].address_verified_at, null);
        const dispatchedBlockAudit = await giftSafetyDb.query(
          'SELECT event_type, from_status, to_status FROM gift_delivery_order_events WHERE order_id = $1',
          [dispatchedBlockSafetyOrderId]
        );
        assert.deepEqual(dispatchedBlockAudit.rows, [{
          event_type: 'reported',
          from_status: 'dispatched',
          to_status: 'reported'
        }]);
      } finally {
        await giftSafetyDb.query('DELETE FROM gift_delivery_order_events WHERE order_id = $1', [dispatchedBlockSafetyOrderId]).catch(() => {});
        await giftSafetyDb.query('DELETE FROM gift_delivery_orders WHERE id = $1', [dispatchedBlockSafetyOrderId]).catch(() => {});
      }

    } finally {
      if (reportId) await giftSafetyDb.query('DELETE FROM user_reports WHERE id = $1', [reportId]).catch(() => {});
      for (const orderId of [blockSafetyOrderId, reportSafetyOrderId].filter(Boolean)) {
        await giftSafetyDb.query('DELETE FROM gift_delivery_order_events WHERE order_id = $1', [orderId]).catch(() => {});
        await giftSafetyDb.query('DELETE FROM gift_delivery_orders WHERE id = $1', [orderId]).catch(() => {});
      }
      await giftSafetyDb.end();
    }

    const block = await request(`/api/blocks/${maleRegistered.user.id}`, {
      method: 'POST',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({})
    });
    assert.equal(block.status, 204);

    const blockedList = await request('/api/blocks', { headers: { Cookie: secondCookie } });
    assert.equal(blockedList.status, 200);
    assert.equal((await blockedList.json()).blocks.some(item => item.id === maleRegistered.user.id), true);

    const afterBlockSearch = await request('/api/profiles/search', { headers: { Cookie: secondCookie } });
    assert.equal((await afterBlockSearch.json()).profiles.some(profile => profile.id === maleRegistered.user.id), false);

    const afterBlockLike = await request(`/api/likes/${maleRegistered.user.id}`, {
      method: 'POST',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({})
    });
    assert.equal(afterBlockLike.status, 404);

    // Blocking must work in both directions: the blocked account cannot create a new like either.
    const reverseAfterBlockLike = await request(`/api/likes/${registered.user.id}`, {
      method: 'POST',
      headers: { Cookie: maleCookie },
      body: JSON.stringify({})
    });
    assert.equal(reverseAfterBlockLike.status, 404,
      'a user must not like an account that has blocked them');

    const blockedMatchMessages = await request(`/api/matches/${matchPayload.match.id}/messages`, {
      headers: { Cookie: secondCookie }
    });
    assert.equal(blockedMatchMessages.status, 404);

    const blockedMatchSend = await request(`/api/matches/${matchPayload.match.id}/messages`, {
      method: 'POST',
      headers: { Cookie: maleCookie },
      body: JSON.stringify({ text: 'This message must not be delivered after a block.' })
    });
    assert.equal(blockedMatchSend.status, 404,
      'neither participant may send messages after the match is blocked');

    const wrongPassword = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'incorrect password' })
    });
    assert.equal(wrongPassword.status, 401);

    const rejectedOrigin = await fetch(`${api}/api/auth/login`, {
      method: 'POST',
      headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    assert.equal(rejectedOrigin.status, 403);

    const missingOrigin = await fetch(api + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    assert.equal(missingOrigin.status, 403);

    const deleteWithoutConfirmation = await request('/api/account', {
      method: 'DELETE',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({})
    });
    assert.equal(deleteWithoutConfirmation.status, 400,
      'account deletion must require explicit password confirmation');

    const deleteWrongPassword = await request('/api/account', {
      method: 'DELETE',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({ password: 'incorrect password' })
    });
    assert.equal(deleteWrongPassword.status, 401);

    // Moderator suspension must also revoke gift address access while keeping
    // provider payment state truthful.
    const moderationSafetyDb = new Pool({ connectionString: process.env.DATABASE_URL });
    let moderationSafetyOrderId;
    let moderationSafetyReportId;
    try {
      await moderationSafetyDb.query("UPDATE users SET role = 'moderator' WHERE id = $1", [registered.user.id]);
      const safetyReport = await moderationSafetyDb.query(
        `INSERT INTO user_reports (reporter_id, reported_user_id, category, details)
         VALUES ($1, $2, 'safety', 'Integration test: moderator suspension gift safety')
         RETURNING id`,
        [registered.user.id, maleRegistered.user.id]
      );
      moderationSafetyReportId = safetyReport.rows[0].id;
      const moderationSafetyOrder = await moderationSafetyDb.query(
        `INSERT INTO gift_delivery_orders
           (match_id, sender_id, recipient_id, product_name_snapshot, product_category,
            total_minor_units, currency, status, payment_status, recipient_consent_at,
            recipient_consent_version, address_vault_ref, address_verified_at, idempotency_key)
         VALUES ($1, $2, $3, 'Moderator safety test chocolate', 'chocolate', 1000, 'USD',
                 'address_verified', 'captured', NOW(), 1, 'test-moderator-vault-reference',
                 NOW(), $4)
         RETURNING id`,
        [matchPayload.match.id, maleRegistered.user.id, registered.user.id, randomUUID()]
      );
      moderationSafetyOrderId = moderationSafetyOrder.rows[0].id;
      const suspend = await request(`/api/admin/reports/${moderationSafetyReportId}/action`, {
        method: 'POST',
        headers: { Cookie: secondCookie },
        body: JSON.stringify({ action: 'suspend_user', confirmed: true, reason: 'integration safety test' })
      });
      assert.equal(suspend.status, 200);
      const suspendedGift = await moderationSafetyDb.query(
        'SELECT status, payment_status, address_vault_ref, address_verified_at FROM gift_delivery_orders WHERE id = $1',
        [moderationSafetyOrderId]
      );
      assert.equal(suspendedGift.rows[0].status, 'blocked');
      assert.equal(suspendedGift.rows[0].payment_status, 'captured',
        'moderator suspension must not pretend a captured payment was refunded');
      assert.equal(suspendedGift.rows[0].address_vault_ref, null);
      assert.equal(suspendedGift.rows[0].address_verified_at, null);
      const moderationAudit = await moderationSafetyDb.query(
        `SELECT actor_type, event_type, from_status, to_status, metadata
         FROM gift_delivery_order_events WHERE order_id = $1 AND event_type = 'safety_hold'`,
        [moderationSafetyOrderId]
      );
      assert.equal(moderationAudit.rowCount, 1);
      assert.equal(moderationAudit.rows[0].actor_type, 'moderator');
      assert.equal(moderationAudit.rows[0].from_status, 'address_verified');
      assert.equal(moderationAudit.rows[0].to_status, 'blocked');
      assert.equal(moderationAudit.rows[0].metadata.reason, 'moderator_suspension');
    } finally {
      if (moderationSafetyReportId) await moderationSafetyDb.query('DELETE FROM user_reports WHERE id = $1', [moderationSafetyReportId]).catch(() => {});
      if (moderationSafetyOrderId) {
        await moderationSafetyDb.query('DELETE FROM gift_delivery_order_events WHERE order_id = $1', [moderationSafetyOrderId]).catch(() => {});
        await moderationSafetyDb.query('DELETE FROM gift_delivery_orders WHERE id = $1', [moderationSafetyOrderId]).catch(() => {});
      }
      await moderationSafetyDb.end();
    }

    // Account deletion must revoke gift address access transactionally without
    // pretending an active payment authorization was voided.
    const deletionSafetyDb = new Pool({ connectionString: process.env.DATABASE_URL });
    let deletionSafetyOrderId;
    let dispatchedDeletionSafetyOrderId;
    try {
      const deletionSafetyOrder = await deletionSafetyDb.query(
        `INSERT INTO gift_delivery_orders
           (match_id, sender_id, recipient_id, product_name_snapshot, product_category,
            total_minor_units, currency, status, payment_status, recipient_consent_at,
            recipient_consent_version, address_vault_ref, address_verified_at, idempotency_key)
         VALUES ($1, $2, $3, 'Account deletion safety test chocolate', 'chocolate', 1000, 'USD',
                 'address_verified', 'authorized', NOW(), 1, 'test-deletion-vault-reference',
                 NOW(), $4)
         RETURNING id`,
        [matchPayload.match.id, maleRegistered.user.id, registered.user.id, randomUUID()]
      );
      deletionSafetyOrderId = deletionSafetyOrder.rows[0].id;

      const dispatchedDeletionSafetyOrder = await deletionSafetyDb.query(
        `INSERT INTO gift_delivery_orders
           (match_id, sender_id, recipient_id, product_name_snapshot, product_category,
            total_minor_units, currency, status, payment_status, recipient_consent_at,
            recipient_consent_version, address_vault_ref, address_verified_at,
            fulfilment_authorized_at, dispatched_at, idempotency_key)
         VALUES ($1, $2, $3, 'Dispatched deletion safety test chocolate', 'chocolate', 1500, 'USD',
                 'dispatched', 'captured', NOW(), 1, 'test-dispatched-deletion-vault-reference',
                 NOW(), NOW(), NOW(), $4)
         RETURNING id`,
        [matchPayload.match.id, maleRegistered.user.id, registered.user.id, randomUUID()]
      );
      dispatchedDeletionSafetyOrderId = dispatchedDeletionSafetyOrder.rows[0].id;

      // A report submitted after dispatch must also quarantine the order and
      // revoke address metadata without simulating a refund.
      const dispatchedReportSafetyOrder = await deletionSafetyDb.query(
        `INSERT INTO gift_delivery_orders
           (match_id, sender_id, recipient_id, product_name_snapshot, product_category,
            total_minor_units, currency, status, payment_status, recipient_consent_at,
            recipient_consent_version, address_vault_ref, address_verified_at,
            fulfilment_authorized_at, dispatched_at, idempotency_key)
         VALUES ($1, $2, $3, 'Dispatched report safety test chocolate', 'chocolate', 1100, 'USD',
                 'dispatched', 'captured', NOW(), 1, 'test-dispatched-report-vault-reference',
                 NOW(), NOW(), NOW(), $4)
         RETURNING id`,
        [matchPayload.match.id, maleRegistered.user.id, registered.user.id, randomUUID()]
      );
      const dispatchedReportSafetyOrderId = dispatchedReportSafetyOrder.rows[0].id;
      let dispatchedReportId;
      try {
        const reportAfterDispatch = await request('/api/reports', {
          method: 'POST',
          headers: { Cookie: secondCookie },
          body: JSON.stringify({
            reportedUserId: maleRegistered.user.id,
            category: 'safety',
            details: 'Integration test: safety report after gift dispatch.'
          })
        });
        assert.equal(reportAfterDispatch.status, 201);
        dispatchedReportId = (await reportAfterDispatch.json()).report.id;
        const reportedDispatchedGift = await deletionSafetyDb.query(
          'SELECT status, payment_status, address_vault_ref, address_verified_at FROM gift_delivery_orders WHERE id = $1',
          [dispatchedReportSafetyOrderId]
        );
        assert.equal(reportedDispatchedGift.rows[0].status, 'reported');
        assert.equal(reportedDispatchedGift.rows[0].payment_status, 'captured',
          'a report after dispatch must not pretend a captured payment was refunded');
        assert.equal(reportedDispatchedGift.rows[0].address_vault_ref, null);
        assert.equal(reportedDispatchedGift.rows[0].address_verified_at, null);
        const dispatchedReportAudit = await deletionSafetyDb.query(
          'SELECT event_type, from_status, to_status FROM gift_delivery_order_events WHERE order_id = $1',
          [dispatchedReportSafetyOrderId]
        );
        assert.deepEqual(dispatchedReportAudit.rows, [{
          event_type: 'reported',
          from_status: 'dispatched',
          to_status: 'reported'
        }]);
      } finally {
        if (dispatchedReportId) await deletionSafetyDb.query('DELETE FROM user_reports WHERE id = $1', [dispatchedReportId]).catch(() => {});
        await deletionSafetyDb.query('DELETE FROM gift_delivery_order_events WHERE order_id = $1', [dispatchedReportSafetyOrderId]).catch(() => {});
        await deletionSafetyDb.query('DELETE FROM gift_delivery_orders WHERE id = $1', [dispatchedReportSafetyOrderId]).catch(() => {});
      }

      const deleteAccount = await request('/api/account', {
        method: 'DELETE',
        headers: { Cookie: secondCookie },
        body: JSON.stringify({ password })
      });
      assert.equal(deleteAccount.status, 204);
      const deletedGift = await deletionSafetyDb.query(
        'SELECT status, payment_status, address_vault_ref, address_verified_at FROM gift_delivery_orders WHERE id = $1',
        [deletionSafetyOrderId]
      );
      assert.equal(deletedGift.rows[0].status, 'blocked');
      assert.equal(deletedGift.rows[0].payment_status, 'authorized',
        'account deletion must not pretend an active authorization was voided');
      assert.equal(deletedGift.rows[0].address_vault_ref, null);
      assert.equal(deletedGift.rows[0].address_verified_at, null);
      const deletionAudit = await deletionSafetyDb.query(
        `SELECT actor_type, event_type, from_status, to_status, metadata
         FROM gift_delivery_order_events WHERE order_id = $1 AND event_type = 'safety_hold'`,
        [deletionSafetyOrderId]
      );
      assert.equal(deletionAudit.rowCount, 1);
      assert.equal(deletionAudit.rows[0].actor_type, 'system');
      assert.equal(deletionAudit.rows[0].from_status, 'address_verified');
      assert.equal(deletionAudit.rows[0].to_status, 'blocked');
      assert.equal(deletionAudit.rows[0].metadata.reason, 'account_deleted');
      const dispatchedGift = await deletionSafetyDb.query(
        'SELECT status, payment_status, address_vault_ref, address_verified_at FROM gift_delivery_orders WHERE id = $1',
        [dispatchedDeletionSafetyOrderId]
      );
      assert.equal(dispatchedGift.rows[0].status, 'reported',
        'a dispatched gift must enter the safety-review state instead of being treated as an ordinary pre-dispatch block');
      assert.equal(dispatchedGift.rows[0].payment_status, 'captured');
      assert.equal(dispatchedGift.rows[0].address_vault_ref, null);
      assert.equal(dispatchedGift.rows[0].address_verified_at, null);
    } finally {
      for (const orderId of [deletionSafetyOrderId, dispatchedDeletionSafetyOrderId].filter(Boolean)) {
        await deletionSafetyDb.query('DELETE FROM gift_delivery_order_events WHERE order_id = $1', [orderId]).catch(() => {});
        await deletionSafetyDb.query('DELETE FROM gift_delivery_orders WHERE id = $1', [orderId]).catch(() => {});
      }
      await deletionSafetyDb.end();
    }

    const deletedAccountMe = await request('/api/auth/me', { headers: { Cookie: secondCookie } });
    assert.equal(deletedAccountMe.status, 401);

    const deletedAccountMatches = await request('/api/matches', { headers: { Cookie: secondCookie } });
    assert.equal(deletedAccountMatches.status, 401,
      'a deleted account must not retain access to server matches');

    const deletedAccountMessages = await request(`/api/matches/${matchPayload.match.id}/messages`, {
      headers: { Cookie: secondCookie }
    });
    assert.equal(deletedAccountMessages.status, 401,
      'a deleted account must not retain access to previously authorized conversations');

  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  }
});
