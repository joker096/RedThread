import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Pool } = pg;

test('gift payment reconciliation ledger installs fenced claim and immutable inbox guards', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const functions = await client.query(
      `SELECT proname FROM pg_proc
        WHERE proname IN (
          'claim_gift_payment_reconciliation_task',
          'heartbeat_gift_payment_reconciliation_task',
          'guard_gift_payment_provider_event_inbox',
          'guard_gift_payment_attempt_identity'
        )`
    );
    const names = new Set(functions.rows.map(row => row.proname));
    for (const name of [
      'claim_gift_payment_reconciliation_task',
      'heartbeat_gift_payment_reconciliation_task',
      'guard_gift_payment_provider_event_inbox',
      'guard_gift_payment_attempt_identity'
    ]) assert.ok(names.has(name), `migration 212 must install ${name}`);

    const publicFunctionGrants = await client.query(
      `SELECT proc.proname, privilege.privilege_type
         FROM pg_proc AS proc
         CROSS JOIN LATERAL aclexplode(COALESCE(proc.proacl, acldefault('f', proc.proowner))) AS privilege
        WHERE proc.oid IN (
          'claim_gift_payment_reconciliation_task(TEXT,INTEGER,INTEGER)'::regprocedure,
          'heartbeat_gift_payment_reconciliation_task(BIGINT,UUID,BIGINT,INTEGER)'::regprocedure
        )
          AND privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'`
    );
    assert.equal(publicFunctionGrants.rowCount, 0,
      'queue claim and heartbeat functions must not be executable by PostgreSQL PUBLIC');

    const healthView = await client.query(
      "SELECT pg_get_viewdef('gift_payment_reconciliation_health'::regclass, true) AS definition"
    );
    const healthDefinition = healthView.rows[0].definition;
    assert.match(healthDefinition, /'pending'/);
    assert.match(healthDefinition, /'failed'/);
    assert.match(healthDefinition, /dead_lettered_at IS NULL/);
    assert.match(healthDefinition, /next_attempt_at <= statement_timestamp/,
      'due_tasks must include due retryable failed tasks, not only pending tasks');

    await assert.rejects(
      client.query('SELECT * FROM claim_gift_payment_reconciliation_task($1, 90, 8)', ['invalid worker name with spaces']),
      error => error.code === '22023'
    );

    await assert.rejects(
      client.query(
        "INSERT INTO gift_payment_provider_event_inbox (provider_key, provider_event_id, event_type, payload_sha256) VALUES ('test_provider', '   ', 'transaction.updated', repeat('a', 64))"
      ),
      error => error.code === '23514'
    );

    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO gift_payment_provider_event_inbox
         (provider_key, provider_event_id, event_type, payload_sha256)
       VALUES ('test_provider', $1, 'transaction.updated', repeat('a', 64))
       RETURNING id`,
      [`event_${Date.now()}_${Math.random().toString(16).slice(2)}`]
    );
    const id = inserted.rows[0].id;
    await assert.rejects(
      client.query(
        'UPDATE gift_payment_provider_event_inbox SET payload_sha256 = repeat(\'b\', 64) WHERE id = $1',
        [id]
      ),
      error => error.code === '55000'
    );
    await client.query('ROLLBACK');
  } finally {
    client.release();
    await pool.end();
  }
});

test('gift reconciliation claims are exclusive and expired leases fence stale workers', {
  skip: !process.env.DATABASE_URL,
  timeout: 35_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const setup = await pool.connect();
  const senderId = (await import('node:crypto')).randomUUID();
  const recipientId = (await import('node:crypto')).randomUUID();
  const matchId = (await import('node:crypto')).randomUUID();
  const orderId = (await import('node:crypto')).randomUUID();
  const workerA = 'lease-test-worker-a';
  const workerB = 'lease-test-worker-b';
  let taskId;
  let isolationLockHeld = false;
  try {
    for (const [id, suffix] of [[senderId, 'sender'], [recipientId, 'recipient']]) {
      await setup.query(
        "INSERT INTO users (id, email, role, status, email_verified_at) VALUES ($1, $2, 'member', 'active', NOW())",
        [id, 'gift-lease-' + suffix + '-' + senderId + '@example.invalid']
      );
    }
    await setup.query(
      "INSERT INTO matches (id, user_a_id, user_b_id, status, created_at) VALUES ($1, LEAST($2::uuid, $3::uuid), GREATEST($2::uuid, $3::uuid), 'active', NOW())",
      [matchId, senderId, recipientId]
    );
    await setup.query(
      "INSERT INTO gift_delivery_orders (id, match_id, sender_id, recipient_id, product_name_snapshot, product_category, total_minor_units, currency, idempotency_key, status, payment_status) VALUES ($1, $2, $3, $4, 'Lease test gift', 'chocolate', 1500, 'USD', $5, 'awaiting_recipient_consent', 'authorized')",
      [orderId, matchId, senderId, recipientId, 'lease-test-' + orderId]
    );

    await assert.rejects(
      setup.query(
        "INSERT INTO gift_payment_attempt_identity (order_id, attempt_id, provider_key, idempotency_key, amount_minor_units, currency) VALUES ($1, gen_random_uuid(), 'test_provider', '   ', 1500, 'USD')",
        [orderId]
      ),
      error => error.code === '23514'
    );
    await assert.rejects(
      setup.query(
        "INSERT INTO gift_payment_attempt_identity (order_id, attempt_id, provider_key, provider_reference, provider_reference_recorded_at, idempotency_key, amount_minor_units, currency) VALUES ($1, gen_random_uuid(), 'test_provider', '   ', NOW(), 'lease-test-idempotency', 1500, 'USD')",
        [orderId]
      ),
      error => error.code === '23514'
    );
    const task = await setup.query(
      "INSERT INTO gift_payment_reconciliation_tasks (order_id, reason, next_attempt_at) VALUES ($1, 'recipient_opted_out', TIMESTAMPTZ '0001-01-01 00:00:00+00') RETURNING id",
      [orderId]
    );
    taskId = task.rows[0].id;

    // The CI database is shared by parallel integration tests. Lock every other
    // queued task so both workers can only compete for this fixture task.
    await setup.query('BEGIN');
    isolationLockHeld = true;
    await setup.query(
      'SELECT id FROM gift_payment_reconciliation_tasks WHERE id <> $1 FOR UPDATE',
      [taskId]
    );

    const [clientA, clientB] = await Promise.all([pool.connect(), pool.connect()]);
    let firstClaim;
    try {
      const claims = await Promise.all([
        clientA.query('SELECT * FROM claim_gift_payment_reconciliation_task($1, 15, 8)', [workerA]),
        clientB.query('SELECT * FROM claim_gift_payment_reconciliation_task($1, 15, 8)', [workerB])
      ]);
      const claimedRows = claims.flatMap(result => result.rows);
      assert.equal(claimedRows.length, 1, 'exactly one concurrent worker may claim the task');
      firstClaim = claimedRows[0];
      assert.equal(String(firstClaim.id), String(taskId));
      assert.ok(firstClaim.lease_token);
      assert.equal(Number(firstClaim.lease_generation), 1);

      await setup.query('SELECT pg_sleep(15.2)');
      const takeover = await clientB.query(
        'SELECT * FROM claim_gift_payment_reconciliation_task($1, 90, 8)',
        [workerB]
      );
      assert.equal(takeover.rowCount, 1, 'a second worker must reclaim an expired lease');
      const secondClaim = takeover.rows[0];
      assert.equal(String(secondClaim.id), String(taskId));
      assert.notEqual(secondClaim.lease_token, firstClaim.lease_token);
      assert.equal(Number(secondClaim.lease_generation), 2);

      const staleHeartbeat = await clientA.query(
        'SELECT heartbeat_gift_payment_reconciliation_task($1, $2, $3, 90) AS accepted',
        [taskId, firstClaim.lease_token, firstClaim.lease_generation]
      );
      assert.equal(staleHeartbeat.rows[0].accepted, false,
        'the old lease token and generation must not heartbeat after takeover');

      const currentHeartbeat = await clientB.query(
        'SELECT heartbeat_gift_payment_reconciliation_task($1, $2, $3, 90) AS accepted',
        [taskId, secondClaim.lease_token, secondClaim.lease_generation]
      );
      assert.equal(currentHeartbeat.rows[0].accepted, true,
        'the current lease owner may extend its still-live lease');

      const staleRelease = await clientA.query(
        "UPDATE gift_payment_reconciliation_tasks SET status = 'failed', last_error_code = 'stale_worker', lease_token = NULL, lease_owner = NULL, claimed_at = NULL, lease_expires_at = NULL WHERE id = $1 AND status = 'in_progress' AND lease_token = $2 AND lease_generation = $3",
        [taskId, firstClaim.lease_token, firstClaim.lease_generation]
      );
      assert.equal(staleRelease.rowCount, 0,
        'a stale worker must not release or overwrite the new owner lease');
      await setup.query('COMMIT');
      isolationLockHeld = false;
    } finally {
      clientA.release();
      clientB.release();
    }
  } finally {
    // These rows are append-only reconciliation evidence. CI uses a disposable database,
    // so retain the fixture rather than bypassing the production immutability guards.
    if (isolationLockHeld) await setup.query('ROLLBACK').catch(() => {});
    setup.release();
    await pool.end();
  }
});
