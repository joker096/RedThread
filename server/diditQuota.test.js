import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { canReserveDiditFreeSession, DIDIT_FREE_MONTHLY_SESSION_LIMIT, releaseDiditSessionReservation } from './diditQuota.js';

const { Pool } = pg;

test('Vow reserves no more than 500 live Didit sessions per UTC month', () => {
  assert.equal(DIDIT_FREE_MONTHLY_SESSION_LIMIT, 500);
  assert.equal(canReserveDiditFreeSession(0), true);
  assert.equal(canReserveDiditFreeSession(499), true);
  assert.equal(canReserveDiditFreeSession(500), false);
  assert.equal(canReserveDiditFreeSession(501), false);
  assert.equal(canReserveDiditFreeSession(-1), false);
  assert.equal(canReserveDiditFreeSession(1.5), false);
  assert.equal(canReserveDiditFreeSession(Number.MAX_SAFE_INTEGER + 1), false);
});


test('definitive provider rejection deletes only an unbound reservation and returns its exact live quota slot', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (String(sql).includes('SELECT environment')) {
        return { rows: [{ environment: 'live', month_start: '2026-11-01' }], rowCount: 1 };
      }
      if (String(sql).includes('DELETE FROM identity_verification_session_reservations')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [{ month_start: '2026-11-01' }], rowCount: 1 };
    }
  };
  assert.equal(await releaseDiditSessionReservation(client, {
    userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  }), true);
  assert.equal(calls.length, 3);
  assert.match(calls[0].sql, /COALESCE\([\s\S]*quota_month_start[\s\S]*created_at AT TIME ZONE 'UTC'/);
  assert.deepEqual(calls[2].params, ['2026-11-01']);
  assert.match(calls[2].sql, /reserved_count = reserved_count - 1/);
  assert.match(calls[2].sql, /reserved_count > 0/);
});

test('reservation release is idempotent and does not release a provider-created session', async () => {
  const client = {
    calls: 0,
    async query(sql) {
      this.calls += 1;
      if (String(sql).includes('SELECT environment')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    }
  };
  assert.equal(await releaseDiditSessionReservation(client, {
    userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  }), false);
  assert.equal(client.calls, 1);
});

test('sandbox reservation release never decrements the live monthly quota', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(String(sql));
      if (String(sql).includes('SELECT environment')) return { rows: [{ environment: 'sandbox', month_start: null }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }
  };
  assert.equal(await releaseDiditSessionReservation(client, {
    userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  }), true);
  assert.equal(calls.length, 2);
  assert.equal(calls.some(sql => sql.includes('UPDATE didit_monthly_quota_usage')), false);
});

test('legacy live reservations without a stored quota month release the original UTC month slot', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const userId = randomUUID();
  const reservationId = randomUUID();
  const email = `didit-release-${userId}@example.invalid`;
  const monthStart = '2026-10-01';
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO users (id, email, status) VALUES ($1, $2, \'active\')',
      [userId, email]
    );
    const usage = await client.query(
      `INSERT INTO didit_monthly_quota_usage (month_start, reserved_count)
       VALUES ($1, 1)
       ON CONFLICT (month_start) DO UPDATE
         SET reserved_count = didit_monthly_quota_usage.reserved_count + 1
       RETURNING reserved_count`,
      [monthStart]
    );
    await client.query(
      `INSERT INTO identity_verification_session_reservations
         (id, user_id, environment, status, quota_month_start, created_at)
       VALUES ($1, $2, 'live', 'reserved', NULL, TIMESTAMPTZ '2026-10-31 23:59:59+00')`,
      [reservationId, userId]
    );
    assert.equal(await releaseDiditSessionReservation(client, { userId, reservationId }), true);
    const after = await client.query(
      'SELECT reserved_count FROM didit_monthly_quota_usage WHERE month_start = $1',
      [monthStart]
    );
    assert.equal(after.rows[0].reserved_count, usage.rows[0].reserved_count - 1);
    const remaining = await client.query(
      'SELECT COUNT(*)::int AS count FROM identity_verification_session_reservations WHERE id = $1',
      [reservationId]
    );
    assert.equal(remaining.rows[0].count, 0);
    assert.equal(await releaseDiditSessionReservation(client, { userId, reservationId }), false);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});
