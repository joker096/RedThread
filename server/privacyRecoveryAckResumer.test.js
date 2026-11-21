import test from 'node:test';
import assert from 'node:assert/strict';
import { resumePendingPrivacyRecoveryLedgerAcks } from './privacyRecoveryAckResumer.js';

const env = {
  NODE_ENV: 'production',
  PRIVACY_RECOVERY_LEDGER_REQUIRED: 'true',
  PRIVACY_RECOVERY_LEDGER_URL: 'https://ledger.example',
  PRIVACY_RECOVERY_LEDGER_HMAC_SECRET: 'auth-secret-at-least-32-characters-long'
};

function fakePool(seed = []) {
  const state = {
    rows: new Map(seed.map(row => [row.operation_id, {
      ack_lease_token: null,
      ack_attempts: 0,
      ack_last_error_code: null,
      ...row
    }])),
    transactionDepth: 0,
    calls: []
  };
  return {
    state,
    async connect() {
      return {
        async query(sql, values = []) {
          const query = String(sql);
          state.calls.push({ query, values });
          if (query === 'BEGIN') { state.transactionDepth += 1; return { rowCount: null, rows: [] }; }
          if (query === 'COMMIT' || query === 'ROLLBACK') {
            state.transactionDepth = Math.max(0, state.transactionDepth - 1);
            return { rowCount: null, rows: [] };
          }
          if (query.includes('WITH candidates AS')) {
            const [limit, leaseToken] = values;
            const due = [...state.rows.values()]
              .filter(row => row.status === 'pending' &&
                (!row.ack_lease_token || row.leaseExpired === true) &&
                row.due !== false)
              .sort((a, b) => a.operation_id.localeCompare(b.operation_id))
              .slice(0, limit);
            for (const row of due) {
              row.ack_lease_token = leaseToken;
              row.ack_attempts += 1;
            }
            return { rowCount: due.length, rows: due.map(row => ({
              operation_id: row.operation_id,
              event_payload: row.event_payload,
              ack_attempts: row.ack_attempts
            })) };
          }
          if (query.includes("SET status = 'acknowledged'")) {
            const [id, leaseToken, sequence] = values;
            const row = state.rows.get(id);
            if (!row || row.status !== 'pending' || row.ack_lease_token !== leaseToken) {
              return { rowCount: 0, rows: [] };
            }
            row.status = 'acknowledged';
            row.ledger_sequence = sequence;
            row.acknowledged_at = true;
            row.ack_lease_token = null;
            row.ack_lease_expires_at = null;
            row.ack_last_error_code = null;
            return { rowCount: 1, rows: [{ operation_id: id }] };
          }
          if (query.includes('ack_next_attempt_at = statement_timestamp() +')) {
            const [id, leaseToken, delay, code] = values;
            const row = state.rows.get(id);
            if (!row || row.status !== 'pending' || row.ack_lease_token !== leaseToken) {
              return { rowCount: 0, rows: [] };
            }
            row.ack_lease_token = null;
            row.ack_last_error_code = code;
            row.retryDelayMs = delay;
            return { rowCount: 1, rows: [] };
          }
          throw new Error(`unexpected query in fake resumer pool: ${query.slice(0, 100)}`);
        },
        release() {}
      };
    }
  };
}

function event(id) {
  return {
    operation_id: id,
    status: 'pending',
    event_payload: {
      event_id: id,
      schema_version: 1,
      event_type: 'private_photo_erasure_requested',
      subject_ref: 'a'.repeat(64),
      resource_ref: 'b'.repeat(64),
      occurred_at: '2026-11-18T08:00:00.000Z'
    }
  };
}

test('ACK resumer commits lease before network and stores matching Ledger acknowledgement', async () => {
  const id = '123e4567-e89b-42d3-a456-426614174010';
  const pool = fakePool([event(id)]);
  let calls = 0;
  const result = await resumePendingPrivacyRecoveryLedgerAcks({
    pool, env, now: () => Date.parse('2026-11-18T08:00:00.000Z'),
    fetchImpl: async (_url, options) => {
      calls += 1;
      assert.equal(pool.state.transactionDepth, 0, 'no PostgreSQL transaction or row lock may remain open during HTTP');
      const payload = JSON.parse(options.body);
      return new Response(JSON.stringify({ accepted: true, event_id: payload.event_id, sequence: 501 }), { status: 201 });
    }
  });
  assert.deepEqual(result, { claimed: 1, acknowledged: 1, deferred: 0, leaseLost: 0 });
  assert.equal(calls, 1);
  assert.equal(pool.state.rows.get(id).status, 'acknowledged');
  assert.equal(pool.state.rows.get(id).ledger_sequence, 501);
  assert.equal(pool.state.rows.get(id).ack_lease_token, null);
  assert.equal(pool.state.rows.get(id).ack_attempts, 1);
});

test('ACK resumer defers transient Ledger failures with bounded retry metadata', async () => {
  const id = '123e4567-e89b-42d3-a456-426614174011';
  const pool = fakePool([event(id)]);
  const result = await resumePendingPrivacyRecoveryLedgerAcks({
    pool, env, baseBackoffMs: 1000, maxBackoffMs: 10_000,
    fetchImpl: async () => {
      assert.equal(pool.state.transactionDepth, 0, 'Ledger failure must not hold database locks');
      throw new Error('socket details must not be persisted');
    }
  });
  assert.deepEqual(result, { claimed: 1, acknowledged: 0, deferred: 1, leaseLost: 0 });
  const row = pool.state.rows.get(id);
  assert.equal(row.status, 'pending');
  assert.equal(row.ack_lease_token, null);
  assert.equal(row.ack_attempts, 1);
  assert.equal(row.retryDelayMs, 1000);
  assert.equal(row.ack_last_error_code, 'privacy_recovery_ledger_unavailable');
  assert.equal(JSON.stringify(row).includes('socket details'), false);
});

test('ACK resumer never overwrites a lease or acknowledgement owned by another worker', async () => {
  const id = '123e4567-e89b-42d3-a456-426614174012';
  const pool = fakePool([event(id)]);
  const result = await resumePendingPrivacyRecoveryLedgerAcks({
    pool, env,
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      pool.state.rows.get(id).ack_lease_token = '123e4567-e89b-42d3-a456-426614174099';
      return new Response(JSON.stringify({ accepted: true, event_id: payload.event_id, sequence: 502 }), { status: 201 });
    }
  });
  assert.deepEqual(result, { claimed: 1, acknowledged: 0, deferred: 0, leaseLost: 1 });
  assert.equal(pool.state.rows.get(id).status, 'pending');
  assert.equal(pool.state.rows.get(id).ack_lease_token, '123e4567-e89b-42d3-a456-426614174099');
});

test('ACK resumer validates bounded worker options', async () => {
  await assert.rejects(resumePendingPrivacyRecoveryLedgerAcks({
    pool: fakePool(), limit: 101, env
  }), /privacy_recovery_ack_resumer_options_invalid/);
});


test('ACK resumer reclaims an expired worker lease and resends the exact persisted event payload', async () => {
  const id = '123e4567-e89b-42d3-a456-426614174013';
  const original = event(id);
  const originalPayload = JSON.stringify(original.event_payload);
  const pool = fakePool([{
    ...original,
    ack_lease_token: '123e4567-e89b-42d3-a456-426614174099',
    ack_lease_expires_at: '2026-11-18T08:00:00.000Z',
    ack_attempts: 1,
    leaseExpired: true
  }]);
  const sent = [];
  const result = await resumePendingPrivacyRecoveryLedgerAcks({
    pool, env, now: () => Date.parse('2026-11-18T08:01:00.000Z'),
    fetchImpl: async (_url, options) => {
      sent.push(options.body);
      assert.equal(pool.state.transactionDepth, 0, 'expired lease must be reclaimed and committed before HTTP');
      const payload = JSON.parse(options.body);
      return new Response(JSON.stringify({
        accepted: true, event_id: payload.event_id, sequence: 503
      }), { status: 201 });
    }
  });

  assert.deepEqual(result, { claimed: 1, acknowledged: 1, deferred: 0, leaseLost: 0 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0], originalPayload, 'retry must resend the exact immutable event payload');
  const row = pool.state.rows.get(id);
  assert.equal(row.status, 'acknowledged');
  assert.equal(row.ledger_sequence, 503);
  assert.equal(row.ack_attempts, 2);
  assert.equal(row.ack_lease_token, null);
  assert.equal(row.ack_lease_expires_at, null);
});
