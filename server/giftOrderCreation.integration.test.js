import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createGiftOrderRequest, listGiftCatalogForMatch, acquireGiftOrderRateLocks, acquireGiftSafetyPairLock, recipientGiftAcceptanceLimitReached, notifyGiftRequestUpdate } from './giftOrderCreationService.js';

const { Pool } = pg;

test('gift order totals project PostgreSQL BIGINT values as exact safe JavaScript numbers', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const result = await pool.query(
      `SELECT value,
         CASE
           WHEN value BETWEEN 0 AND 9007199254740991::bigint
             THEN value::double precision
           ELSE NULL
         END AS "totalMinorUnits"
       FROM UNNEST($1::bigint[]) AS values_table(value)`,
      [['2500', '9007199254740991', '9007199254740992']]
    );
    assert.equal(result.rows[0].totalMinorUnits, 2500);
    assert.equal(typeof result.rows[0].totalMinorUnits, 'number');
    assert.equal(result.rows[1].totalMinorUnits, Number.MAX_SAFE_INTEGER);
    assert.equal(typeof result.rows[1].totalMinorUnits, 'number');
    assert.equal(result.rows[2].totalMinorUnits, null, 'unsafe BIGINT amounts should be excluded rather than rounded');
  } finally {
    await pool.end();
  }
});


async function seedFixture(pool) {
  const client = await pool.connect();
  const ids = {
    sender: randomUUID(),
    recipientA: randomUUID(),
    recipientB: randomUUID(),
    moderator: randomUUID(),
    matchA: randomUUID(),
    matchB: randomUUID(),
    catalogItem: randomUUID(),
    deliveryPartner: randomUUID(),
    supplierKey: `test-supplier-${randomUUID().replaceAll('-', '')}`
  };
  const userIds = [ids.sender, ids.recipientA, ids.recipientB, ids.moderator];
  const matchIds = [ids.matchA, ids.matchB];
  try {
    for (const [index, userId] of userIds.entries()) {
      const email = `gift-test-${randomUUID()}@example.invalid`;
      await client.query(
        'INSERT INTO users (id, email, role, status, email_verified_at) VALUES ($1, $2, $3, \'active\', NOW())',
        [userId, email, index === 3 ? 'moderator' : 'member']
      );
    }

    const profileRows = [
      [ids.sender, 'Gift sender', 'male'],
      [ids.recipientA, 'Gift recipient A', 'female'],
      [ids.recipientB, 'Gift recipient B', 'female'],
      [ids.moderator, 'Gift reviewer', 'female']
    ];
    for (const [userId, displayName, gender] of profileRows) {
      await client.query(
        `INSERT INTO profiles
           (user_id, display_name, birth_date, gender, country, city, children_disclosure_confirmed_at)
         VALUES ($1, $2, DATE '1990-01-01', $3, 'Georgia', 'Tbilisi', NOW())`,
        [userId, displayName, gender]
      );
    }

    await client.query(
      `INSERT INTO user_identity_verifications
         (user_id, verification_level, status, provider_key, verified_at, expires_at, reviewed_by, reviewed_at)
       VALUES ($1, 3, 'approved', 'test_provider', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '30 days', $2, NOW() - INTERVAL '1 day')`,
      [ids.sender, ids.moderator]
    );

    await client.query(
      `INSERT INTO gift_suppliers
         (supplier_key, display_name, status, privacy_reviewed_at, contract_reviewed_at)
       VALUES ($1, 'Test supplier', 'verified', NOW(), NOW())`,
      [ids.supplierKey]
    );
    await client.query(
      `INSERT INTO gift_delivery_partners
         (id, partner_key, display_name, status, privacy_reviewed_at, contract_reviewed_at)
       VALUES ($1, $2, 'Test carrier', 'verified', NOW(), NOW())`,
      [ids.deliveryPartner, `carrier-${randomUUID().replaceAll('-', '')}`]
    );
    await client.query(
      `INSERT INTO gift_delivery_partner_coverage
         (partner_id, country_code, city_key, active, verified_at, delivery_fee_minor_units, delivery_fee_currency)
       VALUES ($1, 'GE', 'Tbilisi', TRUE, NOW(), 300, 'GEL')`,
      [ids.deliveryPartner]
    );
    await client.query(
      `INSERT INTO gift_catalog_items
         (id, sku, category, display_name, description, price_minor_units, currency, supplier_key, approved, active)
       VALUES ($1, $2, 'chocolate', 'Test chocolate', 'Test fixture only', 2500, 'GEL', $3, TRUE, TRUE)`,
      [ids.catalogItem, `gift-${randomUUID().replaceAll('-', '')}`, ids.supplierKey]
    );

    await client.query(
      `INSERT INTO matches (id, user_a_id, user_b_id, status, created_at)
       VALUES
         ($1, LEAST($2::uuid, $3::uuid), GREATEST($2::uuid, $3::uuid), 'active', NOW() - INTERVAL '4 days'),
         ($4, LEAST($2::uuid, $5::uuid), GREATEST($2::uuid, $5::uuid), 'active', NOW() - INTERVAL '4 days')`,
      [ids.matchA, ids.sender, ids.recipientA, ids.matchB, ids.recipientB]
    );
    for (const [matchId, recipientId] of [[ids.matchA, ids.recipientA], [ids.matchB, ids.recipientB]]) {
      for (let i = 0; i < 3; i++) {
        await client.query(
          'INSERT INTO messages (match_id, sender_id, body) VALUES ($1, $2, $3), ($1, $4, $5)',
          [matchId, ids.sender, `Sender message ${i + 1}`, recipientId, `Recipient message ${i + 1}`]
        );
      }
      await client.query(
        'INSERT INTO gift_receiving_preferences (user_id, requests_enabled) VALUES ($1, TRUE)',
        [recipientId]
      );
    }
    return { ids, userIds, matchIds };
  } finally {
    client.release();
  }
}

async function runRequest(pool, input) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await createGiftOrderRequest(client, input);
    await client.query(result.commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function cleanupFixture(pool, fixture) {
  const { ids, userIds, matchIds } = fixture;
  await pool.query(
    `DELETE FROM gift_delivery_order_events
     WHERE order_id IN (
       SELECT id FROM gift_delivery_orders
       WHERE sender_id = ANY($1::uuid[]) OR recipient_id = ANY($1::uuid[])
     )`,
    [userIds]
  );
  await pool.query(
    'DELETE FROM gift_delivery_orders WHERE sender_id = ANY($1::uuid[]) OR recipient_id = ANY($1::uuid[])',
    [userIds]
  );
  await pool.query('DELETE FROM messages WHERE match_id = ANY($1::uuid[])', [matchIds]);
  await pool.query('DELETE FROM matches WHERE id = ANY($1::uuid[])', [matchIds]);
  await pool.query('DELETE FROM gift_receiving_preferences WHERE user_id = ANY($1::uuid[])', [userIds]);
  await pool.query(
    'DELETE FROM user_identity_verifications WHERE user_id = ANY($1::uuid[]) OR reviewed_by = ANY($1::uuid[])',
    [userIds]
  );
  await pool.query('DELETE FROM gift_catalog_items WHERE id = $1', [ids.catalogItem]);
  await pool.query('DELETE FROM gift_delivery_partner_coverage WHERE partner_id = $1', [ids.deliveryPartner]);
  await pool.query('DELETE FROM gift_delivery_partners WHERE id = $1', [ids.deliveryPartner]);
  await pool.query('DELETE FROM gift_suppliers WHERE supplier_key = $1', [ids.supplierKey]);
  await pool.query('DELETE FROM profiles WHERE user_id = ANY($1::uuid[])', [userIds]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
}

test('gift catalog only returns reviewed items and omits recipient location metadata', {
  skip: !process.env.DATABASE_URL,
  timeout: 20_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  let fixture;
  try {
    fixture = await seedFixture(pool);
    // Region matching should tolerate harmless ASCII casing and repeated/outer spaces.
    await pool.query("UPDATE profiles SET city = '  tBiLiSi   ' WHERE user_id = $1", [fixture.ids.recipientA]);
    await pool.query("UPDATE gift_delivery_partner_coverage SET city_key = 'Tbilisi  ' WHERE partner_id = $1", [fixture.ids.deliveryPartner]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await listGiftCatalogForMatch(client, {
        senderId: fixture.ids.sender,
        matchId: fixture.ids.matchA
      });
      await client.query('COMMIT');
      assert.equal(result.status, 200);
      assert.deepEqual(result.items.map(item => ({
        id: item.id,
        category: item.category,
        displayName: item.displayName,
        itemPriceMinorUnits: item.itemPriceMinorUnits,
        deliveryFeeMinorUnits: item.deliveryFeeMinorUnits,
        totalMinorUnits: item.totalMinorUnits,
        currency: item.currency
      })), [{
        id: fixture.ids.catalogItem,
        category: 'chocolate',
        displayName: 'Test chocolate',
        itemPriceMinorUnits: 2500,
        deliveryFeeMinorUnits: 300,
        totalMinorUnits: 2800,
        currency: 'GEL'
      }]);
      for (const key of ['country', 'city', 'recipientCity', 'address', 'phone', 'partnerId', 'deliveryPartnerId']) {
        assert.equal(Object.hasOwn(result.items[0], key), false, 'catalog projection must not expose ' + key);
      }
    } finally {
      client.release();
    }
  } finally {
    if (fixture) await cleanupFixture(pool, fixture);
    await pool.end();
  }
});

test('gift catalog fails closed when recipient preference is disabled or pair safety is restricted', {
  skip: !process.env.DATABASE_URL,
  timeout: 20_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  let fixture;
  try {
    fixture = await seedFixture(pool);
    const { ids } = fixture;
    const client = await pool.connect();
    const list = async () => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const result = await listGiftCatalogForMatch(client, { senderId: ids.sender, matchId: ids.matchA });
        await client.query('COMMIT');
        return result.items;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    };
    try {
      assert.equal((await list()).length, 1);
      await pool.query('UPDATE gift_receiving_preferences SET requests_enabled = FALSE WHERE user_id = $1', [ids.recipientA]);
      assert.deepEqual(await list(), []);
      await pool.query('UPDATE gift_receiving_preferences SET requests_enabled = TRUE WHERE user_id = $1', [ids.recipientA]);
      await pool.query('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)', [ids.sender, ids.recipientA]);
      assert.deepEqual(await list(), []);
    } finally {
      client.release();
    }
  } finally {
    if (fixture) await cleanupFixture(pool, fixture);
    await pool.end();
  }
});

test('creating a gift request atomically notifies only its recipient without location data', {
  skip: !process.env.DATABASE_URL,
  timeout: 20_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
  let fixture;
  try {
    fixture = await seedFixture(pool);
    const { ids } = fixture;
    const result = await runRequest(pool, {
      senderId: ids.sender,
      matchId: ids.matchA,
      catalogItemId: ids.catalogItem,
      idempotencyKey: `notification-test-${randomUUID()}`
    });
    assert.equal(result.status, 201);
    const senderNotifications = await pool.query(
      `SELECT type, metadata FROM user_notifications WHERE user_id = $1 AND type = 'gift_request'`,
      [ids.sender]
    );
    const recipientNotifications = await pool.query(
      `SELECT type, metadata, dedupe_key FROM user_notifications WHERE user_id = $1 AND type = 'gift_request'`,
      [ids.recipientA]
    );
    assert.equal(senderNotifications.rowCount, 0, 'gift request notification must not be sent back to the sender');
    assert.equal(recipientNotifications.rowCount, 1);
    assert.equal(recipientNotifications.rows[0].type, 'gift_request');
    assert.deepEqual(recipientNotifications.rows[0].metadata, { orderReference: result.body.order.id });
    assert.equal(recipientNotifications.rows[0].dedupe_key, `gift_request:${result.body.order.id}`);
    const metadataText = JSON.stringify(recipientNotifications.rows[0].metadata).toLowerCase();
    for (const privateField of ['address', 'phone', 'email', 'city', 'country', 'coordinates']) {
      assert.equal(metadataText.includes(privateField), false, `notification metadata must not include ${privateField}`);
    }
  } finally {
    if (fixture) await cleanupFixture(pool, fixture);
    await pool.end();
  }
});

test('gift request updates notify only the sender with generic, idempotent metadata', {
  skip: !process.env.DATABASE_URL,
  timeout: 20_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
  let fixture;
  try {
    fixture = await seedFixture(pool);
    const { ids } = fixture;
    const request = await runRequest(pool, {
      senderId: ids.sender,
      matchId: ids.matchA,
      catalogItemId: ids.catalogItem,
      idempotencyKey: 'gift-update-notification-' + randomUUID()
    });
    assert.equal(request.status, 201);
    await notifyGiftRequestUpdate(pool, ids.sender, request.body.order.id, 'recipient_decision');
    await notifyGiftRequestUpdate(pool, ids.sender, request.body.order.id, 'recipient_decision');
    const sent = await pool.query(
      "SELECT type, metadata, dedupe_key FROM user_notifications WHERE user_id = $1 AND type = 'gift_request_update'",
      [ids.sender]
    );
    const recipientUpdates = await pool.query(
      "SELECT 1 FROM user_notifications WHERE user_id = $1 AND type = 'gift_request_update'",
      [ids.recipientA]
    );
    assert.equal(sent.rowCount, 1, 'replayed update event must not duplicate the notification');
    assert.equal(recipientUpdates.rowCount, 0, 'update notification goes to the sender, not the recipient');
    assert.deepEqual(sent.rows[0].metadata, { orderReference: request.body.order.id });
    assert.equal(sent.rows[0].dedupe_key, 'gift_request_update:' + request.body.order.id + ':recipient_decision');
    const metadataText = JSON.stringify(sent.rows[0].metadata).toLowerCase();
    for (const forbidden of ['address', 'phone', 'email', 'city', 'country', 'coordinates', 'decision', 'reason']) {
      assert.equal(metadataText.includes(forbidden), false, 'notification metadata must not include ' + forbidden);
    }
    await assert.rejects(
      () => notifyGiftRequestUpdate(pool, ids.sender, request.body.order.id, 'unknown-transition'),
      /invalid_gift_request_update_notification/
    );
  } finally {
    if (fixture) await cleanupFixture(pool, fixture);
    await pool.end();
  }
});

test('concurrent gift requests cannot create two pending requests for the same pair', {
  skip: !process.env.DATABASE_URL,
  timeout: 20_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
  let fixture;
  try {
    fixture = await seedFixture(pool);
    const { ids } = fixture;
    const results = await Promise.all([
      runRequest(pool, {
        senderId: ids.sender,
        matchId: ids.matchA,
        catalogItemId: ids.catalogItem,
        idempotencyKey: `pending-race-${randomUUID()}`
      }),
      runRequest(pool, {
        senderId: ids.sender,
        matchId: ids.matchA,
        catalogItemId: ids.catalogItem,
        idempotencyKey: `pending-race-${randomUUID()}`
      })
    ]);
    assert.equal(results.filter(result => result.status === 201).length, 1);
    assert.equal(results.filter(result => result.status === 409 && result.body.error === 'gift_request_already_pending').length, 1);
    const count = await pool.query(
      `SELECT COUNT(*)::int AS count FROM gift_delivery_orders
       WHERE match_id = $1 AND status = 'awaiting_recipient_consent'`,
      [ids.matchA]
    );
    assert.equal(count.rows[0].count, 1);
  } finally {
    if (fixture) await cleanupFixture(pool, fixture);
    await pool.end();
  }
});

test('concurrent gift requests cannot exceed the sender rolling 30-day cap', {
  skip: !process.env.DATABASE_URL,
  timeout: 20_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
  let fixture;
  try {
    fixture = await seedFixture(pool);
    const { ids } = fixture;
    // Two historical requests count regardless of whether they were declined.
    for (const [matchId, recipientId] of [[ids.matchA, ids.recipientA], [ids.matchB, ids.recipientB]]) {
      await pool.query(
        `INSERT INTO gift_delivery_orders
           (match_id, sender_id, recipient_id, catalog_item_id, product_name_snapshot, product_category,
            item_price_minor_units, delivery_fee_minor_units, delivery_fee_currency,
            total_minor_units, currency, delivery_partner_id, status, payment_status, idempotency_key,
            created_at)
         VALUES ($1, $2, $3, $4, 'Historical test chocolate', 'chocolate',
                 2500, 300, 'GEL', 2800, 'GEL', $5, 'declined', 'not_started', $6,
                 NOW() - INTERVAL '1 day')`,
        [matchId, ids.sender, recipientId, ids.catalogItem, ids.deliveryPartner, `history-${randomUUID()}`]
      );
    }

    const results = await Promise.all([
      runRequest(pool, {
        senderId: ids.sender,
        matchId: ids.matchA,
        catalogItemId: ids.catalogItem,
        idempotencyKey: `limit-race-${randomUUID()}`
      }),
      runRequest(pool, {
        senderId: ids.sender,
        matchId: ids.matchB,
        catalogItemId: ids.catalogItem,
        idempotencyKey: `limit-race-${randomUUID()}`
      })
    ]);
    assert.equal(results.filter(result => result.status === 201).length, 1);
    assert.equal(results.filter(result => result.status === 429 && result.body.error === 'gift_request_rate_limited').length, 1);
    const count = await pool.query(
      `SELECT COUNT(*)::int AS count FROM gift_delivery_orders
       WHERE sender_id = $1 AND created_at >= NOW() - INTERVAL '30 days'`,
      [ids.sender]
    );
    assert.equal(count.rows[0].count, 3);
  } finally {
    if (fixture) await cleanupFixture(pool, fixture);
    await pool.end();
  }
});


test('concurrent acceptances from different pairs cannot exceed recipient weekly gift limit', {
  skip: !process.env.DATABASE_URL,
  timeout: 25_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
  let fixture;
  try {
    fixture = await seedFixture(pool);
    const { ids } = fixture;
    ids.matchC = randomUUID();
    fixture.matchIds.push(ids.matchC);

    await pool.query(
      "INSERT INTO user_identity_verifications (user_id, verification_level, status, provider_key, verified_at, expires_at) VALUES ($1, 1, 'approved', 'test_provider', NOW() - INTERVAL '1 day', NOW() + INTERVAL '30 days')",
      [ids.recipientB]
    );
    await pool.query(
      "INSERT INTO matches (id, user_a_id, user_b_id, status, created_at) VALUES ($1, LEAST($2::uuid, $3::uuid), GREATEST($2::uuid, $3::uuid), 'active', NOW() - INTERVAL '4 days')",
      [ids.matchC, ids.recipientA, ids.recipientB]
    );
    for (let i = 0; i < 3; i++) {
      await pool.query(
        "INSERT INTO messages (match_id, sender_id, body) VALUES ($1, $2, $3), ($1, $4, $5)",
        [ids.matchC, ids.recipientA, "Recipient A message " + (i + 1), ids.recipientB, "Recipient B message " + (i + 1)]
      );
    }

    const insertPending = "INSERT INTO gift_delivery_orders (match_id, sender_id, recipient_id, catalog_item_id, product_name_snapshot, product_category, item_price_minor_units, delivery_fee_minor_units, delivery_fee_currency, total_minor_units, currency, delivery_partner_id, status, payment_status, idempotency_key) VALUES ($1, $2, $3, $4, 'Test chocolate', 'chocolate', 2500, 300, 'GEL', 2800, 'GEL', $5, 'awaiting_recipient_consent', 'not_started', $6) RETURNING id";
    const [orderA, orderB] = await Promise.all([
      pool.query(insertPending, [ids.matchA, ids.sender, ids.recipientA, ids.catalogItem, ids.deliveryPartner, "accept-race-" + randomUUID()]),
      pool.query(insertPending, [ids.matchC, ids.recipientB, ids.recipientA, ids.catalogItem, ids.deliveryPartner, "accept-race-" + randomUUID()])
    ]);

    const accept = async (orderId, senderId) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await acquireGiftOrderRateLocks(client, senderId, ids.recipientA);
        await acquireGiftSafetyPairLock(client, senderId, ids.recipientA);
        const selected = await client.query(
          "SELECT id, status FROM gift_delivery_orders WHERE id = $1 AND recipient_id = $2 FOR UPDATE",
          [orderId, ids.recipientA]
        );
        if (!selected.rows[0] || selected.rows[0].status !== 'awaiting_recipient_consent') {
          await client.query('ROLLBACK');
          return 'not_actionable';
        }
        if (await recipientGiftAcceptanceLimitReached(client, ids.recipientA)) {
          await client.query('ROLLBACK');
          return 'rate_limited';
        }
        const updated = await client.query(
          "UPDATE gift_delivery_orders SET status = 'recipient_accepted', recipient_consent_at = NOW(), recipient_consent_version = 1, updated_at = NOW() WHERE id = $1 AND status = 'awaiting_recipient_consent' RETURNING id",
          [orderId]
        );
        assert.equal(updated.rowCount, 1);
        await client.query('COMMIT');
        return 'accepted';
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    };

    const results = await Promise.all([
      accept(orderA.rows[0].id, ids.sender),
      accept(orderB.rows[0].id, ids.recipientB)
    ]);
    assert.equal(results.filter(result => result === 'accepted').length, 1);
    assert.equal(results.filter(result => result === 'rate_limited').length, 1);

    const counts = await pool.query(
      "SELECT COUNT(*) FILTER (WHERE status = 'recipient_accepted' AND recipient_consent_at >= NOW() - INTERVAL '7 days')::int AS accepted_recently, COUNT(*) FILTER (WHERE status = 'awaiting_recipient_consent')::int AS pending FROM gift_delivery_orders WHERE recipient_id = $1",
      [ids.recipientA]
    );
    assert.equal(counts.rows[0].accepted_recently, 1);
    assert.equal(counts.rows[0].pending, 1);
  } finally {
    if (fixture) await cleanupFixture(pool, fixture);
    await pool.end();
  }
});


test('expired unpaid pending request is closed and audited before a replacement request', {
  skip: !process.env.DATABASE_URL,
  timeout: 20_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
  let fixture;
  try {
    fixture = await seedFixture(pool);
    const { ids } = fixture;
    const stale = await pool.query(
      `INSERT INTO gift_delivery_orders (
         match_id, sender_id, recipient_id, catalog_item_id, product_name_snapshot,
         product_category, item_price_minor_units, delivery_fee_minor_units,
         delivery_fee_currency, total_minor_units, currency, delivery_partner_id,
         status, payment_status, idempotency_key, created_at, expires_at
       ) VALUES ($1, $2, $3, $4, 'Old chocolate', 'chocolate',
                 2500, 300, 'GEL', 2800, 'GEL', $5,
                 'awaiting_recipient_consent', 'not_started', $6,
                 NOW() - INTERVAL '4 days', NOW() - INTERVAL '1 second')
       RETURNING id`,
      [ids.matchA, ids.sender, ids.recipientA, ids.catalogItem, ids.deliveryPartner, 'expired-test-' + randomUUID()]
    );
    const result = await runRequest(pool, {
      senderId: ids.sender,
      matchId: ids.matchA,
      catalogItemId: ids.catalogItem,
      idempotencyKey: 'replacement-test-' + randomUUID()
    });
    assert.equal(result.status, 201);
    const expired = await pool.query('SELECT status FROM gift_delivery_orders WHERE id = $1', [stale.rows[0].id]);
    assert.equal(expired.rows[0].status, 'expired');
    const event = await pool.query(
      "SELECT 1 FROM gift_delivery_order_events WHERE order_id = $1 AND event_type = 'expired'",
      [stale.rows[0].id]
    );
    assert.equal(event.rowCount, 1, 'expiration must be recorded in the audit trail');
    const pending = await pool.query(
      "SELECT COUNT(*)::int AS count FROM gift_delivery_orders WHERE match_id = $1 AND status = 'awaiting_recipient_consent'",
      [ids.matchA]
    );
    assert.equal(pending.rows[0].count, 1);
  } finally {
    if (fixture) await cleanupFixture(pool, fixture);
    await pool.end();
  }
});

test('expired request cannot be replayed with its original idempotency key', {
  skip: !process.env.DATABASE_URL,
  timeout: 20_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
  let fixture;
  try {
    fixture = await seedFixture(pool);
    const { ids } = fixture;
    const idempotencyKey = 'expired-replay-' + randomUUID();
    const stale = await pool.query(
      `INSERT INTO gift_delivery_orders (
         match_id, sender_id, recipient_id, catalog_item_id, product_name_snapshot,
         product_category, item_price_minor_units, delivery_fee_minor_units,
         delivery_fee_currency, total_minor_units, currency, delivery_partner_id,
         status, payment_status, idempotency_key, created_at, expires_at
       ) VALUES ($1, $2, $3, $4, 'Expired replay chocolate', 'chocolate',
                 2500, 300, 'GEL', 2800, 'GEL', $5,
                 'awaiting_recipient_consent', 'not_started', $6,
                 NOW() - INTERVAL '4 days', NOW() - INTERVAL '1 second')
       RETURNING id`,
      [ids.matchA, ids.sender, ids.recipientA, ids.catalogItem, ids.deliveryPartner, idempotencyKey]
    );

    const result = await runRequest(pool, {
      senderId: ids.sender,
      matchId: ids.matchA,
      catalogItemId: ids.catalogItem,
      idempotencyKey
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'gift_request_expired');

    const order = await pool.query(
      'SELECT status, payment_status FROM gift_delivery_orders WHERE id = $1',
      [stale.rows[0].id]
    );
    assert.deepEqual(order.rows[0], { status: 'expired', payment_status: 'not_started' });
    const count = await pool.query(
      'SELECT COUNT(*)::int AS count FROM gift_delivery_orders WHERE match_id = $1',
      [ids.matchA]
    );
    assert.equal(count.rows[0].count, 1, 'replaying an expired key must not create a replacement order');
  } finally {
    if (fixture) await cleanupFixture(pool, fixture);
    await pool.end();
  }
});


test('expired requests with unresolved payment state fail closed and remain unchanged', {
  skip: !process.env.DATABASE_URL,
  timeout: 20_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
  let fixture;
  try {
    fixture = await seedFixture(pool);
    const { ids } = fixture;
    const stale = await pool.query(
      `INSERT INTO gift_delivery_orders (
         match_id, sender_id, recipient_id, catalog_item_id, product_name_snapshot,
         product_category, item_price_minor_units, delivery_fee_minor_units,
         delivery_fee_currency, total_minor_units, currency, delivery_partner_id,
         status, payment_status, idempotency_key, created_at, expires_at
       ) VALUES ($1, $2, $3, $4, 'Old chocolate', 'chocolate',
                 2500, 300, 'GEL', 2800, 'GEL', $5,
                 'awaiting_recipient_consent', 'authorization_pending', $6,
                 NOW() - INTERVAL '4 days', NOW() - INTERVAL '1 second')
       RETURNING id`,
      [ids.matchA, ids.sender, ids.recipientA, ids.catalogItem, ids.deliveryPartner, 'expired-payment-test-' + randomUUID()]
    );
    const result = await runRequest(pool, {
      senderId: ids.sender,
      matchId: ids.matchA,
      catalogItemId: ids.catalogItem,
      idempotencyKey: 'blocked-replacement-test-' + randomUUID()
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'gift_payment_requires_reconciliation');
    const order = await pool.query('SELECT status, payment_status FROM gift_delivery_orders WHERE id = $1', [stale.rows[0].id]);
    assert.deepEqual(order.rows[0], {
      status: 'awaiting_recipient_consent',
      payment_status: 'authorization_pending'
    });
    const count = await pool.query(
      "SELECT COUNT(*)::int AS count FROM gift_delivery_orders WHERE match_id = $1 AND status = 'awaiting_recipient_consent'",
      [ids.matchA]
    );
    assert.equal(count.rows[0].count, 1);
  } finally {
    if (fixture) await cleanupFixture(pool, fixture);
    await pool.end();
  }
});
