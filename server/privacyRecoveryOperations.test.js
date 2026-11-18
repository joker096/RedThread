import test from 'node:test';
import assert from 'node:assert/strict';
import { derivePrivacyRecoveryOperationId, runAckGatedPrivacyRecoveryOperation } from './privacyRecoveryOperations.js';

const env = {
  NODE_ENV: 'production',
  PRIVACY_RECOVERY_LEDGER_REQUIRED: 'true',
  PRIVACY_RECOVERY_LEDGER_URL: 'https://ledger.example',
  PRIVACY_RECOVERY_LEDGER_HMAC_SECRET: 'auth-secret-at-least-32-characters-long',
  PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY: 'pseudonym-secret-at-least-32-characters'
};
const operationId = '123e4567-e89b-42d3-a456-426614174000';
const event = {
  eventType: 'account_erasure_requested',
  userId: '123e4567-e89b-42d3-a456-426614174001',
  occurredAt: '2026-11-18T08:00:00.000Z'
};

function fakePool() {
  const state = { row: null, calls: [] };
  return {
    state,
    async connect() {
      return {
        async query(sql, values = []) {
          state.calls.push({ sql, values });
          if (sql.includes('INSERT INTO privacy_recovery_operations')) {
            if (state.row) return { rowCount: 0, rows: [] };
            state.row = { operation_id: values[0], event_payload: JSON.parse(values[1]), status: 'pending', ledger_sequence: null };
            return { rowCount: 1, rows: [{ operation_id: values[0], status: 'pending', ledger_sequence: null }] };
          }
          if (sql.includes('SELECT 1 FROM privacy_recovery_operations')) {
            return state.row && JSON.stringify(state.row.event_payload) === JSON.stringify(JSON.parse(values[1]))
              ? { rowCount: 1, rows: [{ status: state.row.status, ledger_sequence: state.row.ledger_sequence }] }
              : { rowCount: 0, rows: [] };
          }
          if (sql.includes('SELECT status, ledger_sequence')) {
            return state.row ? { rowCount: 1, rows: [{ status: state.row.status, ledger_sequence: state.row.ledger_sequence }] } : { rowCount: 0, rows: [] };
          }
          if (sql.includes("SET status = 'acknowledged'")) {
            if (state.row.status !== 'pending') return { rowCount: 0, rows: [] };
            state.row.status = 'acknowledged';
            state.row.ledger_sequence = values[1];
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes("SET status = 'applied'")) {
            if (state.row.status !== 'acknowledged') return { rowCount: 0, rows: [] };
            state.row.status = 'applied';
            return { rowCount: 1, rows: [] };
          }
          return { rowCount: 0, rows: [] };
        },
        release() {}
      };
    }
  };
}

test('operation identifiers must satisfy the Ledger UUIDv4 contract', async () => {
  const pool = fakePool();
  await assert.rejects(runAckGatedPrivacyRecoveryOperation({
    pool, operationId: '123e4567-e89b-12d3-a456-426614174000', event, env,
    fetchImpl: async () => { throw new Error('must not call'); },
    apply: async () => {}
  }), /privacy_recovery_operation_id_invalid/);
  assert.equal(pool.state.calls.length, 0, 'invalid IDs must not persist intents or contact Ledger');
});

test('ledger outage persists intent but never invokes the domain mutation', async () => {
  const pool = fakePool();
  let applied = 0;
  await assert.rejects(runAckGatedPrivacyRecoveryOperation({
    pool, operationId, event, env,
    fetchImpl: async () => { throw new Error('offline'); },
    apply: async () => { applied += 1; }
  }), /privacy_recovery_ledger_unavailable/);
  assert.equal(pool.state.row.status, 'pending');
  assert.equal(applied, 0);
});

test('a failed domain transaction can resume from a separately persisted ledger ACK', async () => {
  const pool = fakePool();
  const bodies = [];
  const fetchImpl = async (_url, options) => {
    bodies.push(options.body);
    return new Response(JSON.stringify({ accepted: true, event_id: operationId, sequence: 77 }), { status: 201 });
  };
  await assert.rejects(runAckGatedPrivacyRecoveryOperation({
    pool, operationId, event, env, fetchImpl,
    apply: async () => { throw new Error('domain transaction rolled back'); }
  }), /domain transaction rolled back/);
  assert.equal(pool.state.row.status, 'acknowledged');

  let applied = 0;
  const resumed = await runAckGatedPrivacyRecoveryOperation({
    pool, operationId, event, env, fetchImpl,
    apply: async () => { applied += 1; return 'domain-change'; }
  });
  assert.equal(resumed.applied, true);
  assert.equal(resumed.sequence, 77);
  assert.equal(applied, 1);
  assert.equal(pool.state.row.status, 'applied');
  assert.equal(bodies.length, 1, 'a persisted ACK allows resume without another Ledger request');
});

test('repeated completed operation is idempotent and does not repeat domain side effects', async () => {
  const pool = fakePool();
  const fetchImpl = async () => new Response(JSON.stringify({ accepted: true, event_id: operationId, sequence: 78 }), { status: 201 });
  let applied = 0;
  await runAckGatedPrivacyRecoveryOperation({
    pool, operationId, event, env, fetchImpl, apply: async () => { applied += 1; }
  });
  const duplicate = await runAckGatedPrivacyRecoveryOperation({
    pool, operationId, event, env, fetchImpl, apply: async () => { applied += 1; }
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(applied, 1);
});

test('reusing an operation ID with a different event payload is rejected', async () => {
  const pool = fakePool();
  const fetchImpl = async () => new Response(JSON.stringify({ accepted: true, event_id: operationId, sequence: 79 }), { status: 201 });
  await runAckGatedPrivacyRecoveryOperation({ pool, operationId, event, env, fetchImpl, apply: async () => {} });
  await assert.rejects(runAckGatedPrivacyRecoveryOperation({
    pool, operationId, event: { ...event, eventType: 'ad_consent_revoked' }, env, fetchImpl, apply: async () => {}
  }), /privacy_recovery_operation_id_conflict/);
});


test('resource transition operation IDs are stable across retries and distinct across generations', () => {
  const identity = { eventType: 'gift_order_consent_withdrawn', userId: 'user-1', resourceId: 'order-1', generation: 'withdrawal-v1' };
  const first = derivePrivacyRecoveryOperationId(identity);
  assert.equal(derivePrivacyRecoveryOperationId(identity), first);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(derivePrivacyRecoveryOperationId({ ...identity, generation: 'withdrawal-v2' }), first);
  assert.notEqual(derivePrivacyRecoveryOperationId({ ...identity, eventType: 'ad_consent_revoked' }), first);
  assert.notEqual(derivePrivacyRecoveryOperationId({ ...identity, resourceId: 'order-2' }), first);
});

test('resource transition operation IDs reject missing or unbounded identity components', () => {
  assert.throws(() => derivePrivacyRecoveryOperationId({ eventType: 'gift_order_consent_withdrawn', userId: 'user-1' }), /privacy_recovery_operation_identity_invalid/);
  assert.throws(() => derivePrivacyRecoveryOperationId({ eventType: 'gift_order_consent_withdrawn', userId: 'user-1', resourceId: 'order-1', generation: 'x'.repeat(201) }), /privacy_recovery_operation_identity_invalid/);
  assert.throws(() => derivePrivacyRecoveryOperationId({ eventType: 'gift_order_consent_withdrawn', userId: 'user-1', resourceId: 'order-1', generation: Number.NaN }), /privacy_recovery_operation_identity_invalid/);
});
