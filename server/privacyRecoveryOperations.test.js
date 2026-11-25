import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { derivePrivacyRecoveryOperationId, runAckGatedPrivacyRecoveryOperation, runAckGatedPrivacyRecoveryBatch } from './privacyRecoveryOperations.js';

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
            return { rowCount: 1, rows: [{ operation_id: values[0], status: 'pending', ledger_sequence: null, event_payload: state.row.event_payload }] };
          }
          if (sql.includes('SELECT status, ledger_sequence, event_payload')) {
            return state.row
              ? { rowCount: 1, rows: [{ status: state.row.status, ledger_sequence: state.row.ledger_sequence, event_payload: state.row.event_payload }] }
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
  const retryEvent = { eventType: event.eventType, userId: event.userId };
  const fetchImpl = async (_url, options) => {
    bodies.push(options.body);
    return new Response(JSON.stringify({ accepted: true, event_id: operationId, sequence: 77 }), { status: 201 });
  };
  await assert.rejects(runAckGatedPrivacyRecoveryOperation({
    pool, operationId, event: retryEvent, env, fetchImpl, now: () => Date.parse('2026-11-18T08:00:00.000Z'),
    apply: async () => { throw new Error('domain transaction rolled back'); }
  }), /domain transaction rolled back/);
  assert.equal(pool.state.row.status, 'acknowledged');

  let applied = 0;
  const resumed = await runAckGatedPrivacyRecoveryOperation({
    pool, operationId, event: retryEvent, env, fetchImpl, now: () => Date.parse('2026-11-18T09:00:00.000Z'),
    apply: async () => { applied += 1; return 'domain-change'; }
  });
  assert.equal(resumed.applied, true);
  assert.equal(resumed.sequence, 77);
  assert.equal(applied, 1);
  assert.equal(pool.state.row.status, 'applied');
  assert.equal(bodies.length, 1, 'a persisted ACK allows resume without another Ledger request');
  assert.equal(JSON.parse(bodies[0]).occurred_at, '2026-11-18T08:00:00.000Z', 'the first committed event time remains authoritative on retries');
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


function fakeBatchPool() {
  const state = { rows: new Map(), calls: [] };
  return {
    state,
    async connect() {
      return {
        async query(sql, values = []) {
          state.calls.push({ sql: String(sql), values });
          const query = String(sql);
          if (query.includes('INSERT INTO privacy_recovery_operations')) {
            const id = values[0];
            if (state.rows.has(id)) return { rowCount: 0, rows: [] };
            const row = { operation_id: id, event_payload: JSON.parse(values[1]), status: 'pending', ledger_sequence: null };
            state.rows.set(id, row);
            return { rowCount: 1, rows: [{ ...row }] };
          }
          if (query.includes('SELECT status, ledger_sequence, event_payload')) {
            const row = state.rows.get(values[0]);
            return row ? { rowCount: 1, rows: [{ status: row.status, ledger_sequence: row.ledger_sequence, event_payload: row.event_payload }] } : { rowCount: 0, rows: [] };
          }
          if (query.includes('SELECT status, ledger_sequence')) {
            const row = state.rows.get(values[0]);
            return row ? { rowCount: 1, rows: [{ status: row.status, ledger_sequence: row.ledger_sequence }] } : { rowCount: 0, rows: [] };
          }
          if (query.includes('SELECT operation_id, status, ledger_sequence')) {
            const rows = values[0].map(id => state.rows.get(id)).filter(Boolean).sort((a, b) => a.operation_id.localeCompare(b.operation_id));
            return { rowCount: rows.length, rows: rows.map(row => ({ operation_id: row.operation_id, status: row.status, ledger_sequence: row.ledger_sequence })) };
          }
          if (query.includes("SET status = 'acknowledged'")) {
            const row = state.rows.get(values[0]);
            if (row.status !== 'pending') return { rowCount: 0, rows: [] };
            row.status = 'acknowledged';
            row.ledger_sequence = values[1];
            return { rowCount: 1, rows: [] };
          }
          if (query.includes("SET status = 'applied'")) {
            const row = state.rows.get(values[0]);
            if (row.status !== 'acknowledged') return { rowCount: 0, rows: [] };
            row.status = 'applied';
            return { rowCount: 1, rows: [] };
          }
          return { rowCount: 0, rows: [] };
        },
        release() {}
      };
    }
  };
}

test('multi-resource privacy batch waits for every Ledger ACK before any domain mutation', async () => {
  const pool = fakeBatchPool();
  const operations = [
    {
      operationId: '123e4567-e89b-42d3-a456-426614174010',
      event: { eventType: 'voice_intro_erasure_requested', userId: 'user-1', resourceId: 'clip-1' }
    },
    {
      operationId: '123e4567-e89b-42d3-a456-426614174011',
      event: { eventType: 'voice_intro_consent_withdrawn', userId: 'user-1' }
    }
  ];
  let applied = 0;
  let remoteCalls = 0;
  const failingFetch = async (_url, options) => {
    remoteCalls += 1;
    const payload = JSON.parse(options.body);
    if (payload.event_type === 'voice_intro_consent_withdrawn') throw new Error('ledger offline');
    return new Response(JSON.stringify({ accepted: true, event_id: payload.event_id, sequence: 91 }), { status: 201 });
  };
  await assert.rejects(runAckGatedPrivacyRecoveryBatch({
    pool, operations, env, fetchImpl: failingFetch, now: () => Date.parse('2026-11-18T10:00:00.000Z'),
    apply: async () => { applied += 1; }
  }), /privacy_recovery_ledger_unavailable/);
  assert.equal(applied, 0, 'no clip may be deleted while any batch event lacks an ACK');
  assert.deepEqual([...pool.state.rows.values()].map(row => row.status).sort(), ['acknowledged', 'pending']);

  const retryFetch = async (_url, options) => {
    remoteCalls += 1;
    const payload = JSON.parse(options.body);
    return new Response(JSON.stringify({ accepted: true, event_id: payload.event_id, sequence: 92 }), { status: 201 });
  };
  const completed = await runAckGatedPrivacyRecoveryBatch({
    pool, operations, env, fetchImpl: retryFetch, now: () => Date.parse('2026-11-18T11:00:00.000Z'),
    apply: async client => {
      applied += 1;
      await client.query('DELETE FROM profile_voice_intros WHERE user_id = $1', ['user-1']);
      return 'all-clips-erased';
    }
  });
  assert.equal(completed.applied, true);
  assert.equal(completed.duplicate, false);
  assert.equal(completed.result, 'all-clips-erased');
  assert.equal(applied, 1);
  assert.deepEqual([...pool.state.rows.values()].map(row => row.status), ['applied', 'applied']);
  assert.equal(remoteCalls, 3, 'retry reuses the first ACK and contacts Ledger only for the pending event');

  const duplicate = await runAckGatedPrivacyRecoveryBatch({
    pool, operations, env,
    fetchImpl: async () => { throw new Error('applied batch must not contact Ledger'); },
    apply: async () => { applied += 1; }
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(applied, 1, 'completed batch never repeats the domain mutation');
});


test('voice intro erasure uses one ACK-gated batch for clip deletion and consent withdrawal', () => {
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const start = source.indexOf("app.delete('/api/profiles/me/voice-intro'");
  const end = source.indexOf("app.get('/api/profiles/:userId/voice-intro'", start);
  assert.ok(start >= 0 && end > start, 'voice intro delete route boundaries must exist');
  const route = source.slice(start, end);
  assert.ok(route.includes('const preflight = await pool.query'));
  assert.ok(route.includes('runAckGatedPrivacyRecoveryBatch({'));
  assert.equal(route.includes('enqueuePrivacyRecoveryEvent'), false);
  assert.ok(route.includes("eventType: 'voice_intro_erasure_requested'"));
  assert.ok(route.includes("eventType: 'voice_intro_consent_withdrawn'"));
  assert.ok(route.includes('currentConsent.granted_at === expectedConsent.granted_at'));
  assert.ok(route.includes('currentClip.created_at === expectedClip.created_at'));
  assert.ok(route.includes('queuePrivateVoiceIntroPurges(transactionClient'));
  assert.ok(route.includes('DELETE FROM profile_voice_intros'));
  assert.ok(route.includes('voice_intro_state_changed_retry'));
});


test('profile photo erasure is ACK-gated and revalidates the immutable asset set after ACK', () => {
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const start = source.indexOf("app.patch('/api/profiles/me'");
  const end = source.indexOf("app.post('/api/passes/undo'", start);
  assert.ok(start >= 0 && end > start, 'profile update route boundaries must exist');
  const route = source.slice(start, end);
  assert.ok(route.includes('const preflight = await pool.query'),
    'photo identities must be read before obtaining the remote Ledger ACK');
  assert.ok(route.includes('expectedRemovedAssets = preflight.rows'));
  assert.ok(route.includes('derivePrivacyRecoveryOperationId({'));
  assert.ok(route.includes('runAckGatedPrivacyRecoveryBatch({'));
  assert.equal(route.includes('enqueuePrivacyRecoveryEvent'), false);
  assert.ok(route.includes('created_at::text AS created_at'));
  assert.ok(route.includes('private_photo_erasure_set_changed_retry'));
  assert.ok(route.includes('queuePrivatePhotoPurges(transactionClient'));
  assert.ok(route.includes('DELETE FROM photo_assets'));
});


test('account erasure obtains Ledger ACK outside session locks and revalidates before tombstoning', () => {
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const start = source.indexOf("app.delete('/api/account'");
  const end = source.indexOf("app.get('/api/billing/status'", start);
  assert.ok(start >= 0 && end > start, 'account deletion route boundaries must exist');
  const route = source.slice(start, end);
  const unlockSafety = route.indexOf("pg_advisory_unlock(hashtext($1))', [safetyLockKey]");
  const unlockCheckout = route.indexOf("pg_advisory_unlock(hashtext($1))', [checkoutLockKey]");
  const ledgerAck = route.indexOf('runAckGatedPrivacyRecoveryOperation({');
  assert.ok(unlockSafety >= 0 && unlockCheckout > unlockSafety && ledgerAck > unlockCheckout,
    'both session locks must be released before waiting for the remote Ledger ACK');
  assert.equal(route.includes('enqueuePrivacyRecoveryEvent'), false);
  assert.ok(route.includes('generation: account.rows[0].account_created_at'));
  assert.ok(route.includes('deletion_pending_at = COALESCE(deletion_pending_at, statement_timestamp())'));
  assert.ok(route.includes("SET status = 'suspended'"));
  assert.ok(route.includes('account_deletion_identity_changed_retry'));
  assert.ok(route.includes('account_deletion_billing_state_changed_retry'));
  assert.ok(route.includes('pg_advisory_xact_lock(hashtext($1))'));
  assert.ok(route.includes('queuePrivatePhotoPurges(transactionClient'));
  assert.ok(route.includes('queuePrivateVoiceIntroPurges(transactionClient'));
  assert.ok(route.includes("SET status = 'deleted'"));
});


test('a positive Ledger ACK followed by PostgreSQL ACK-persistence failure retries the same immutable event', async () => {
  const pool = fakePool();
  let failAckPersistence = true;
  const originalConnect = pool.connect.bind(pool);
  pool.connect = async () => {
    const client = await originalConnect();
    const originalQuery = client.query.bind(client);
    client.query = async (sql, values = []) => {
      if (failAckPersistence && String(sql).includes("SET status = 'acknowledged'")) {
        failAckPersistence = false;
        throw new Error('postgres_ack_commit_unavailable');
      }
      return originalQuery(sql, values);
    };
    return client;
  };

  const accepted = new Map();
  const attempts = [];
  const fetchImpl = async (_url, options) => {
    const body = options.body;
    const payload = JSON.parse(body);
    attempts.push({ body, eventId: payload.event_id });
    const previous = accepted.get(payload.event_id);
    if (previous && previous.body !== body) {
      return new Response(JSON.stringify({ accepted: false, error: 'event_id_conflict' }), { status: 409 });
    }
    if (!previous) accepted.set(payload.event_id, { body, sequence: 880 });
    return new Response(JSON.stringify({
      accepted: true, duplicate: Boolean(previous),
      event_id: payload.event_id, sequence: accepted.get(payload.event_id).sequence
    }), { status: previous ? 200 : 201 });
  };

  await assert.rejects(runAckGatedPrivacyRecoveryOperation({
    pool, operationId, event, env, fetchImpl,
    apply: async () => { throw new Error('must not apply before ACK is durable'); }
  }), /postgres_ack_commit_unavailable/);
  assert.equal(accepted.size, 1, 'the independent Ledger accepted the first delivery');
  assert.equal(pool.state.row.status, 'pending', 'failed PostgreSQL ACK persistence leaves the operation retryable');

  let applied = 0;
  const resumed = await runAckGatedPrivacyRecoveryOperation({
    pool, operationId, event: { ...event, occurredAt: '2026-11-18T12:00:00.000Z' },
    env, fetchImpl, apply: async () => { applied += 1; return 'deleted'; }
  });
  assert.equal(resumed.applied, true);
  assert.equal(resumed.sequence, 880);
  assert.equal(applied, 1);
  assert.equal(pool.state.row.status, 'applied');
  assert.equal(attempts.length, 2, 'the retry redelivers the accepted event idempotently');
  assert.equal(attempts[0].eventId, operationId);
  assert.equal(attempts[1].eventId, operationId);
  assert.equal(attempts[1].body, attempts[0].body,
    'retry must use the originally persisted payload and timestamp, not the later request timestamp');
});


test('a client with an unsuccessful rollback is destroyed instead of returned to the pool', async () => {
  const pool = fakePool();
  const originalConnect = pool.connect.bind(pool);
  let releasedWith = null;
  pool.connect = async () => {
    const client = await originalConnect();
    const originalQuery = client.query.bind(client);
    client.query = async (sql, values = []) => {
      if (String(sql) === 'ROLLBACK') throw new Error('rollback_connection_lost');
      return originalQuery(sql, values);
    };
    client.release = error => { releasedWith = error || null; };
    return client;
  };

  await assert.rejects(runAckGatedPrivacyRecoveryOperation({
    pool, operationId, event, env,
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      return new Response(JSON.stringify({
        accepted: true, event_id: payload.event_id, sequence: 881
      }), { status: 201 });
    },
    apply: async () => { throw new Error('domain_transaction_failed'); }
  }), /domain_transaction_failed/);

  assert.equal(pool.state.row.status, 'acknowledged');
  assert.equal(releasedWith?.message, 'domain_transaction_failed',
    'failed transaction clients must be released with an error so pg destroys them');
});


test('L3 consent withdrawal routes every lifecycle through ACK gating and handles duplicate ACK completion', () => {
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const start = source.indexOf("app.delete('/api/identity/l3/consent'");
  const end = source.indexOf("\napp.", start + 10);
  const route = source.slice(start, end > start ? end : undefined);
  assert.ok(route.includes('runAckGatedPrivacyRecoveryOperation({'));
  assert.ok(route.includes("generation: expectedConsent"));
  assert.ok(route.includes("identity_l3_consent_lifecycle_missing_reconciliation_required"));
  assert.ok(route.includes('if (operation.duplicate)'));
  assert.ok(route.includes('FROM identity_l3_media_purge_jobs'));
  assert.equal(route.includes('client = await pool.connect()'), false);
});
