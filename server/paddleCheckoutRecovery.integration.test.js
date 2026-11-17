import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  claimPaddleCheckoutRecovery,
  runPaddleCheckoutRecoveryOnce
} from './process-paddle-checkout-recovery.js';

const { Pool } = pg;

async function createAttempt(pool, suffix) {
  const userId = randomUUID();
  const attemptId = randomUUID();
  await pool.query(
    "INSERT INTO users (id, email, role, status, email_verified_at) VALUES ($1, $2, 'member', 'active', NOW())",
    [userId, `checkout-recovery-${suffix}-${userId}@example.invalid`]
  );
  await pool.query(
    `INSERT INTO paddle_checkout_attempts
       (user_id, attempt_id, plan, status, created_at, updated_at, recovery_next_attempt_at)
     VALUES ($1, $2, '1month', 'creating',
             statement_timestamp() - INTERVAL '3 minutes',
             statement_timestamp(), statement_timestamp())`,
    [userId, attemptId]
  );
  return { userId, attemptId };
}

function withSandboxPriceConfig(fn) {
  const keys = [
    'PADDLE_PRICE_ID_1MONTH',
    'PADDLE_EXPECTED_CURRENCY_CODE',
    'PADDLE_EXPECTED_AMOUNT_MINOR_1MONTH'
  ];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  process.env.PADDLE_PRICE_ID_1MONTH = 'pri_month_test';
  process.env.PADDLE_EXPECTED_CURRENCY_CODE = 'USD';
  process.env.PADDLE_EXPECTED_AMOUNT_MINOR_1MONTH = '990';
  return Promise.resolve().then(fn).finally(() => {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function matchingProviderResponse(attemptId, userId, transactionId = 'txn_recovered123') {
  return {
    ok: true,
    async json() {
      return {
        data: [{
          id: transactionId,
          status: 'ready',
          custom_data: { userId, plan: '1month', checkoutAttemptId: attemptId },
          items: [{ price: { id: 'pri_month_test' }, quantity: 1 }],
          currency_code: 'USD',
          details: { totals: { total: '990' } }
        }],
        meta: { pagination: { has_more: false, next: null } }
      };
    }
  };
}

test('PostgreSQL recovery claims are exclusive and an expired lease fences the stale claimant', {
  skip: !process.env.DATABASE_URL,
  timeout: 20_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const fixture = await createAttempt(pool, 'lease');
  try {
    const claims = await Promise.all([
      claimPaddleCheckoutRecovery(pool, { leaseMs: 30_000, staleMs: 30_000 }),
      claimPaddleCheckoutRecovery(pool, { leaseMs: 30_000, staleMs: 30_000 })
    ]);
    assert.equal(claims.filter(Boolean).length, 1, 'only one concurrent worker may claim a checkout attempt');
    const first = claims.find(Boolean);
    assert.equal(first.user_id, fixture.userId);
    assert.ok(first.leaseToken);

    await pool.query(
      `UPDATE paddle_checkout_attempts
          SET recovery_lease_expires_at = statement_timestamp() - INTERVAL '1 second'
        WHERE user_id = $1 AND recovery_lease_token = $2`,
      [fixture.userId, first.leaseToken]
    );
    const takeover = await claimPaddleCheckoutRecovery(pool, { leaseMs: 30_000, staleMs: 30_000 });
    assert.ok(takeover, 'a second worker may reclaim an expired lease');
    assert.notEqual(takeover.leaseToken, first.leaseToken);

    const staleCompletion = await pool.query(
      `UPDATE paddle_checkout_attempts
          SET status = 'pending', transaction_id = 'txn_stale_worker'
        WHERE user_id = $1 AND attempt_id = $2
          AND status = 'creating' AND recovery_lease_token = $3
          AND recovery_lease_expires_at > statement_timestamp()
          AND (transaction_id IS NULL OR transaction_id = 'txn_stale_worker')`,
      [fixture.userId, fixture.attemptId, first.leaseToken]
    );
    assert.equal(staleCompletion.rowCount, 0, 'the stale lease token must not attach a transaction');
  } finally {
    await pool.query('DELETE FROM users WHERE id = $1', [fixture.userId]);
    await pool.end();
  }
});

test('recovery re-reads the same sandbox transaction after a DB failure following provider response; it never POSTs', {
  skip: !process.env.DATABASE_URL,
  timeout: 20_000
}, async () => withSandboxPriceConfig(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const fixture = await createAttempt(pool, 'crash');
  let failFirstFinish = true;
  let providerReads = 0;
  const wrappedPool = {
    query: (...args) => pool.query(...args),
    async connect() {
      const client = await pool.connect();
      return {
        query: async (sql, params) => {
          if (failFirstFinish && sql.includes('SET status = COALESCE($4, status)')) {
            failFirstFinish = false;
            throw Object.assign(new Error('simulated_recovery_commit_loss'), {
              code: 'simulated_recovery_commit_loss'
            });
          }
          return client.query(sql, params);
        },
        release: () => client.release()
      };
    }
  };
  const fetchImpl = async (_url, options) => {
    providerReads += 1;
    assert.equal(options.method, 'GET');
    return matchingProviderResponse(fixture.attemptId, fixture.userId);
  };
  try {
    await assert.rejects(
      runPaddleCheckoutRecoveryOnce(wrappedPool, {
        apiKey: 'sandbox_test_key',
        environment: 'sandbox',
        fetchImpl,
        dryRun: false
      }),
      /simulated_recovery_commit_loss/
    );
    const afterFailure = await pool.query(
      'SELECT status, transaction_id, recovery_lease_token, recovery_last_error_code FROM paddle_checkout_attempts WHERE user_id = $1',
      [fixture.userId]
    );
    assert.equal(afterFailure.rows[0].status, 'creating');
    assert.equal(afterFailure.rows[0].transaction_id, null);
    assert.equal(afterFailure.rows[0].recovery_lease_token, null,
      'the failed apply is safely released for a later read-only retry');
    assert.equal(afterFailure.rows[0].recovery_last_error_code, 'simulated_recovery_commit_loss');

    await pool.query(
      'UPDATE paddle_checkout_attempts SET recovery_next_attempt_at = statement_timestamp() WHERE user_id = $1',
      [fixture.userId]
    );
    const recovered = await runPaddleCheckoutRecoveryOnce(pool, {
      apiKey: 'sandbox_test_key',
      environment: 'sandbox',
      fetchImpl,
      dryRun: false
    });
    assert.equal(recovered.action, 'attach_pending');
    assert.equal(recovered.transactionId, 'txn_recovered123');
    assert.equal(providerReads, 2, 'recovery must read the same provider transaction again');
    const finalState = await pool.query(
      'SELECT status, transaction_id FROM paddle_checkout_attempts WHERE user_id = $1',
      [fixture.userId]
    );
    assert.equal(finalState.rows[0].status, 'pending');
    assert.equal(finalState.rows[0].transaction_id, 'txn_recovered123');
  } finally {
    await pool.query('DELETE FROM users WHERE id = $1', [fixture.userId]);
    await pool.end();
  }
}));

test('a stale recovery worker cannot attach a transaction after another worker takes over its lease', {
  skip: !process.env.DATABASE_URL,
  timeout: 20_000
}, async () => withSandboxPriceConfig(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const fixture = await createAttempt(pool, 'stale-worker');
  let releaseProviderResponse;
  let providerRequestStarted;
  const started = new Promise(resolve => { providerRequestStarted = resolve; });
  const blocked = new Promise(resolve => { releaseProviderResponse = resolve; });
  const fetchImpl = async (_url, options) => {
    assert.equal(options.method, 'GET');
    providerRequestStarted();
    await blocked;
    return matchingProviderResponse(fixture.attemptId, fixture.userId);
  };
  try {
    const staleWorker = runPaddleCheckoutRecoveryOnce(pool, {
      apiKey: 'sandbox_test_key',
      environment: 'sandbox',
      fetchImpl,
      dryRun: false
    });
    await started;
    const firstLease = await pool.query(
      'SELECT recovery_lease_token FROM paddle_checkout_attempts WHERE user_id = $1',
      [fixture.userId]
    );
    assert.ok(firstLease.rows[0].recovery_lease_token);
    await pool.query(
      `UPDATE paddle_checkout_attempts
          SET recovery_lease_expires_at = statement_timestamp() - INTERVAL '1 second'
        WHERE user_id = $1`,
      [fixture.userId]
    );
    const takeover = await claimPaddleCheckoutRecovery(pool);
    assert.ok(takeover);
    assert.notEqual(takeover.leaseToken, firstLease.rows[0].recovery_lease_token);

    releaseProviderResponse();
    await assert.rejects(staleWorker, /paddle_checkout_recovery_lease_lost/);
    const finalState = await pool.query(
      'SELECT status, transaction_id, recovery_lease_token FROM paddle_checkout_attempts WHERE user_id = $1',
      [fixture.userId]
    );
    assert.equal(finalState.rows[0].status, 'creating');
    assert.equal(finalState.rows[0].transaction_id, null,
      'the stale worker must not attach its provider response');
    assert.equal(finalState.rows[0].recovery_lease_token, takeover.leaseToken,
      'the new lease owner remains untouched');
  } finally {
    releaseProviderResponse?.();
    await pool.query('DELETE FROM users WHERE id = $1', [fixture.userId]);
    await pool.end();
  }
}));
