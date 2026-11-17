import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
export const PADDLE_CHECKOUT_RECOVERY_STALE_MS = 120_000;
export const PADDLE_CHECKOUT_RECOVERY_LEASE_MS = 90_000;
export const PADDLE_CHECKOUT_RECOVERY_MAX_ATTEMPTS = 5;
export const PADDLE_CHECKOUT_RECOVERY_MAX_PAGES = 5;
export function paddleRecoveryRetryDelayMs(attempt) {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > PADDLE_CHECKOUT_RECOVERY_MAX_ATTEMPTS) throw new RangeError('invalid_paddle_recovery_attempt');
  return Math.min(60 * 60_000, 60_000 * (2 ** (attempt - 1)));
}
export const PADDLE_CHECKOUT_RECOVERY_PAGE_SIZE = 30;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN_PRICE_ENV = Object.freeze({
  '1month': 'PADDLE_PRICE_ID_1MONTH',
  '3months': 'PADDLE_PRICE_ID_3MONTHS',
  lifetime: 'PADDLE_PRICE_ID_LIFETIME'
});

export function paddleRecoveryWindow(createdAt, now = Date.now()) {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created) || !Number.isFinite(now) || created > now + 30_000) {
    throw new TypeError('invalid_paddle_checkout_recovery_time');
  }
  return {
    from: new Date(created - 60_000).toISOString(),
    to: new Date(now + 30_000).toISOString()
  };
}

export function paddleRecoveryTransactionMatches(transaction, attempt, expected) {
  const expectedPriceId = expected?.priceId;
  const expectedCurrencyCode = expected?.currencyCode;
  const expectedAmountMinorUnits = expected?.amountMinorUnits;
  const custom = transaction?.custom_data;
  const attemptId = attempt?.attempt_id;
  const validIdentity = UUID_RE.test(String(attemptId || '')) &&
    UUID_RE.test(String(attempt?.user_id || '')) &&
    ['1month', '3months', 'lifetime'].includes(attempt?.plan);
  if (!validIdentity || !expectedPriceId || typeof expectedPriceId !== 'string' ||
      typeof expectedCurrencyCode !== 'string' || !/^[A-Z]{3}$/.test(expectedCurrencyCode) ||
      typeof expectedAmountMinorUnits !== 'string' || !/^\d+$/.test(expectedAmountMinorUnits)) {
    return { kind: 'invalid_configuration' };
  }
  if (custom?.checkoutAttemptId !== attemptId) return { kind: 'no_match' };
  if (custom?.userId !== attempt.user_id || custom?.plan !== attempt.plan) {
    return { kind: 'identity_conflict' };
  }
  const items = Array.isArray(transaction?.items) ? transaction.items : [];
  const exactItems = items.filter(item =>
    (item?.price?.id || item?.price_id || item?.priceId) === expectedPriceId &&
    Number(item?.quantity) === 1
  );
  if (items.length !== 1 || exactItems.length !== 1) return { kind: 'price_conflict' };
  const currencyCode = String(transaction?.currency_code || '').toUpperCase();
  const amountMinorUnits = transaction?.details?.totals?.total;
  if (currencyCode !== expectedCurrencyCode || String(amountMinorUnits) !== expectedAmountMinorUnits) {
    return { kind: 'financial_snapshot_conflict' };
  }
  if (typeof transaction?.id !== 'string' || !/^txn_[A-Za-z0-9]+$/.test(transaction.id)) {
    return { kind: 'invalid_transaction' };
  }
  return { kind: 'match', transactionId: transaction.id, status: String(transaction.status || '').toLowerCase() };
}

export function paddleRecoveryDecision(matches, { pageLimitReached = false } = {}) {
  if (!Array.isArray(matches)) throw new TypeError('matches must be an array');
  if (matches.length > 1) return { action: 'quarantine', reason: 'multiple_provider_matches' };
  if (pageLimitReached) return { action: 'defer', reason: 'provider_page_limit_reached' };
  if (matches.length === 0) return {
    action: pageLimitReached ? 'defer' : 'not_found',
    reason: pageLimitReached ? 'provider_page_limit_reached' : 'provider_match_not_visible'
  };
  const match = matches[0];
  if (match.kind !== 'match') return { action: 'quarantine', reason: match.kind };
  if (['draft', 'ready'].includes(match.status)) {
    return { action: 'attach_pending', transactionId: match.transactionId };
  }
  if (['paid', 'completed', 'billed'].includes(match.status)) {
    return { action: 'quarantine_with_transaction', transactionId: match.transactionId, reason: 'provider_payment_requires_webhook_reconciliation' };
  }
  if (match.status === 'canceled') {
    return { action: 'attach_canceled', transactionId: match.transactionId };
  }
  return { action: 'quarantine_with_transaction', transactionId: match.transactionId, reason: 'provider_status_unrecognized' };
}

function safeSandboxNextUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'sandbox-api.paddle.com' ||
        url.port || url.username || url.password || url.pathname !== '/transactions') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export async function listPaddleTransactionsForAttempt({
  apiKey, attempt, fetchImpl = globalThis.fetch, maxPages = PADDLE_CHECKOUT_RECOVERY_MAX_PAGES,
  now = Date.now(), expected
} = {}) {
  if (typeof apiKey !== 'string' || !apiKey || typeof fetchImpl !== 'function' ||
      !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10 ||
      !PLAN_PRICE_ENV[attempt?.plan] || !expected?.priceId || !expected?.currencyCode || !expected?.amountMinorUnits) {
    throw new Error('paddle_checkout_recovery_not_configured');
  }
  const window = paddleRecoveryWindow(attempt.created_at, now);
  const params = new URLSearchParams();
  params.set('created_at[gte]', window.from);
  params.set('created_at[lte]', window.to);
  params.set('order_by', 'created_at[ASC]');
  params.set('per_page', String(PADDLE_CHECKOUT_RECOVERY_PAGE_SIZE));
  let url = 'https://sandbox-api.paddle.com/transactions?' + params.toString();
  const matches = [];
  let pages = 0;
  let hasMore = false;
  while (url && pages < maxPages) {
    const safeUrl = safeSandboxNextUrl(url);
    if (!safeUrl) throw new Error('paddle_recovery_pagination_url_invalid');
    const response = await fetchImpl(safeUrl, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + apiKey, 'Paddle-Version': '1', 'Skip-Count': 'true' },
      signal: AbortSignal.timeout(10_000)
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(payload?.data) || !payload?.meta?.pagination) {
      throw new Error('paddle_recovery_provider_list_failed');
    }
    pages += 1;
    for (const transaction of payload.data) {
      const result = paddleRecoveryTransactionMatches(transaction, attempt, expected);
      if (result.kind !== 'no_match') matches.push(result);
    }
    hasMore = payload.meta.pagination.has_more === true;
    if (!hasMore) break;
    url = safeSandboxNextUrl(payload.meta.pagination.next);
    if (!url) throw new Error('paddle_recovery_pagination_url_invalid');
  }
  return { matches, pages, pageLimitReached: hasMore && pages >= maxPages };
}

export async function claimPaddleCheckoutRecovery(pool, {
  leaseMs = PADDLE_CHECKOUT_RECOVERY_LEASE_MS,
  staleMs = PADDLE_CHECKOUT_RECOVERY_STALE_MS,
  maxAttempts = PADDLE_CHECKOUT_RECOVERY_MAX_ATTEMPTS
} = {}) {
  if (!Number.isInteger(leaseMs) || leaseMs < 30_000 || leaseMs > 10 * 60_000 ||
      !Number.isInteger(staleMs) || staleMs < 30_000 || staleMs > 24 * 60 * 60_000 ||
      !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    throw new RangeError('invalid_paddle_checkout_recovery_limits');
  }
  const client = await pool.connect();
  const leaseToken = randomUUID();
  try {
    await client.query('BEGIN');
    const claimed = await client.query(
      `WITH candidate AS (
         SELECT user_id FROM paddle_checkout_attempts
         WHERE status = 'creating'
           AND created_at <= statement_timestamp() - ($1::int * INTERVAL '1 millisecond')
           AND recovery_attempt_count < $2
           AND recovery_next_attempt_at <= statement_timestamp()
           AND (recovery_lease_expires_at IS NULL OR recovery_lease_expires_at <= statement_timestamp())
         ORDER BY created_at, user_id
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE paddle_checkout_attempts AS a
       SET recovery_lease_token = $3,
           recovery_lease_expires_at = statement_timestamp() + ($4::int * INTERVAL '1 millisecond'),
           recovery_attempt_count = recovery_attempt_count + 1,
           recovery_last_error_code = NULL
       FROM candidate c
       WHERE a.user_id = c.user_id
       RETURNING a.user_id, a.attempt_id, a.plan, a.created_at, a.transaction_id,
                 a.recovery_attempt_count, a.recovery_lease_token`,
      [staleMs, maxAttempts, leaseToken, leaseMs]
    );
    await client.query('COMMIT');
    return claimed.rows[0] ? { ...claimed.rows[0], leaseToken } : null;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function finishRecovery(pool, attempt, decision, { dryRun = true, errorCode = null } = {}) {
  if (dryRun) return { ...decision, dryRun: true };
  const client = await pool.connect();
  try {
    const status = decision.action === 'attach_pending' ? 'pending'
      : decision.action === 'attach_canceled' ? 'canceled'
        : ['quarantine', 'quarantine_with_transaction'].includes(decision.action)
          ? 'reconciliation_required' : null;
    const transactionId = decision.transactionId || null;
    const result = await client.query(
      `UPDATE paddle_checkout_attempts
       SET status = COALESCE($4, status),
           transaction_id = COALESCE($5, transaction_id),
           recovery_lease_token = NULL,
           recovery_lease_expires_at = NULL,
           recovery_last_checked_at = statement_timestamp(),
           recovery_next_attempt_at = CASE WHEN $4 IS NULL AND $6 IS NOT NULL THEN statement_timestamp() + ($7::int * INTERVAL '1 millisecond') ELSE recovery_next_attempt_at END,
           recovery_last_error_code = $6,
           updated_at = statement_timestamp()
       WHERE user_id = $1 AND attempt_id = $2::uuid
         AND status = 'creating'
         AND recovery_lease_token = $3::uuid
         AND recovery_lease_expires_at > statement_timestamp()
         AND (transaction_id IS NULL OR transaction_id = $5)
       RETURNING status, transaction_id`,
      [attempt.user_id, attempt.attempt_id, attempt.leaseToken, status, transactionId, errorCode, paddleRecoveryRetryDelayMs(attempt.recovery_attempt_count)]
    );
    if (!result.rowCount) throw new Error('paddle_checkout_recovery_lease_lost');
    return { ...decision, status: result.rows[0].status, transactionId: result.rows[0].transaction_id };
  } finally {
    client.release();
  }
}

export async function runPaddleCheckoutRecoveryOnce(pool, {
  apiKey = process.env.PADDLE_API_KEY,
  environment = process.env.PADDLE_ENVIRONMENT,
  fetchImpl = globalThis.fetch,
  dryRun = process.env.PADDLE_CHECKOUT_RECOVERY_APPLY !== 'true',
  maxPages = PADDLE_CHECKOUT_RECOVERY_MAX_PAGES
} = {}) {
  if (environment !== 'sandbox') throw new Error('paddle_checkout_recovery_sandbox_only');
  if (!apiKey) throw new Error('paddle_checkout_recovery_not_configured');
  const attempt = dryRun
    ? (await pool.query(`SELECT user_id, attempt_id, plan, created_at, transaction_id, recovery_attempt_count
         FROM paddle_checkout_attempts
         WHERE status = 'creating' AND created_at <= statement_timestamp() - ($1::int * INTERVAL '1 millisecond')
           AND recovery_attempt_count < $2 AND recovery_next_attempt_at <= statement_timestamp()
         ORDER BY created_at, user_id LIMIT 1`, [PADDLE_CHECKOUT_RECOVERY_STALE_MS, PADDLE_CHECKOUT_RECOVERY_MAX_ATTEMPTS])).rows[0]
    : await claimPaddleCheckoutRecovery(pool);
  if (!attempt) return { processed: false };
  const expected = {
    priceId: process.env[PLAN_PRICE_ENV[attempt.plan]],
    currencyCode: String(process.env.PADDLE_EXPECTED_CURRENCY_CODE || '').toUpperCase(),
    amountMinorUnits: process.env['PADDLE_EXPECTED_AMOUNT_MINOR_' + attempt.plan.replace(/[^a-z0-9]/g, '').toUpperCase()]
  };
  try {
    if (!expected.priceId || !/^pri_[A-Za-z0-9]+$/.test(expected.priceId) ||
        !/^[A-Z]{3}$/.test(expected.currencyCode) || !/^\d+$/.test(String(expected.amountMinorUnits || ''))) {
      return await finishRecovery(pool, attempt, { action: 'quarantine', reason: 'expected_price_not_configured' }, { dryRun, errorCode: 'expected_price_not_configured' });
    }
    const listed = await listPaddleTransactionsForAttempt({ apiKey, attempt, fetchImpl, maxPages, expected });
    const classified = listed.matches.map(match => match);
    let decision = paddleRecoveryDecision(classified, { pageLimitReached: listed.pageLimitReached });
    if (['not_found', 'defer'].includes(decision.action) && attempt.recovery_attempt_count >= PADDLE_CHECKOUT_RECOVERY_MAX_ATTEMPTS) {
      decision = { action: 'quarantine', reason: 'provider_match_not_proven_after_bounded_retries' };
    }
    const result = await finishRecovery(pool, attempt, decision, {
      dryRun,
      errorCode: decision.action === 'defer' ? 'provider_page_limit_reached'
        : decision.action === 'not_found' ? 'provider_match_not_visible' : null
    });
    return { processed: true, userId: attempt.user_id, attemptId: attempt.attempt_id, pages: listed.pages, ...result };
  } catch (error) {
    const code = typeof error?.message === 'string' && /^[a-z0-9_]{1,80}$/.test(error.message)
      ? error.message : 'paddle_recovery_failed';
    if (!dryRun) {
      const exhausted = attempt.recovery_attempt_count >= PADDLE_CHECKOUT_RECOVERY_MAX_ATTEMPTS;
      await finishRecovery(pool, attempt, exhausted
        ? { action: 'quarantine', reason: 'provider_lookup_failed_after_bounded_retries' }
        : { action: 'defer', reason: 'provider_lookup_failed' }, {
        dryRun: false, errorCode: code
      }).catch(() => {});
    }
    throw error;
  }
}

async function main() {
  if (process.env.PADDLE_ENVIRONMENT !== 'sandbox') throw new Error('paddle_checkout_recovery_sandbox_only');
  if (!process.env.DATABASE_URL || !process.env.PADDLE_API_KEY) throw new Error('paddle_checkout_recovery_not_configured');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 5_000,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined });
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    do {
      const result = await runPaddleCheckoutRecoveryOnce(pool);
      if (result.processed) console.log('Paddle checkout recovery:', JSON.stringify(result));
      else if (!stopping) await new Promise(resolve => setTimeout(resolve, 5_000));
    } while (!stopping);
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('Paddle checkout recovery stopped:', error?.message || 'unknown_error');
    process.exitCode = 1;
  });
}
