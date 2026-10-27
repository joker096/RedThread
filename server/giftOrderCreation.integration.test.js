test('idempotent gift replay is denied after a mutual block is added', {
  skip: !process.env.DATABASE_URL,
  timeout: 20_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
  let fixture;
  try {
    fixture = await seedFixture(pool);
    const { ids } = fixture;
    const input = {
      senderId: ids.sender,
      matchId: ids.matchA,
      catalogItemId: ids.catalogItem,
      idempotencyKey: 'safety-replay-' + randomUUID()
    };
    const first = await runRequest(pool, input);
    assert.equal(first.status, 201);
    assert.equal(first.body.order.status, 'awaiting_recipient_consent');

    await pool.query(
      'INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)',
      [ids.recipientA, ids.sender]
    );
    const replay = await runRequest(pool, input);
    assert.equal(replay.status, 409);
    assert.deepEqual(replay.body, { error: 'gift_request_unavailable' });
    assert.equal(Object.hasOwn(replay.body, 'order'), false, 'blocked replay must not disclose existing order details');

    const stored = await pool.query(
      'SELECT status FROM gift_delivery_orders WHERE sender_id = $1 AND idempotency_key = $2',
      [ids.sender, input.idempotencyKey]
    );
    assert.equal(stored.rowCount, 1, 'replay denial must not create a second order');
    assert.equal(stored.rows[0].status, 'awaiting_recipient_consent');
  } finally {
    if (fixture) await cleanupFixture(pool, fixture);
    await pool.end();
  }
});

test('expired unpaid pending request is closed and audited before a replacement request', {