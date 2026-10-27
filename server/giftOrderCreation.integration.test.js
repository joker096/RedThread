import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createGiftOrderRequest, listGiftCatalogForMatch } from './giftOrderCreationService.js';

const { Pool } = pg;

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
