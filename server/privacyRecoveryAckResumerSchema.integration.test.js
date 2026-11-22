import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { resumePendingPrivacyRecoveryLedgerAcks } from './privacyRecoveryAckResumer.js';
import { startTestPrivacyRecoveryLedger } from './testPrivacyRecoveryLedger.js';

const { Pool } = pg;

test('PostgreSQL ACK resumer claims due operations, delivers outside transaction and persists ACK lease release', {
  skip: !process.env.DATABASE_URL,
  timeout: 30_000
}, async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const ledger = await startTestPrivacyRecoveryLedger();
  const operationId = randomUUID();
  const payload = {
    event_id: operationId,
    schema_version: 1,
    event_type: 'private_photo_erasure_requested',
    subject_ref: 'a'.repeat(64),
    resource_ref: 'b'.repeat(64),
    occurred_at: '2026-11-18T08:00:00.000Z'
  };
  const env = {
    NODE_ENV: 'test',
    PRIVACY_RECOVERY_LEDGER_REQUIRED: 'true',
    PRIVACY_RECOVERY_LEDGER_URL: ledger.url,
    PRIVACY_RECOVERY_LEDGER_HMAC_SECRET: 'test-ledger-hmac-secret-'.padEnd(40, 'x')
  };

  try {
    await db.query(
      `INSERT INTO privacy_recovery_operations (operation_id, event_id, event_payload)
       VALUES ($1, $1, $2::jsonb)`,
      [operationId, JSON.stringify(payload)]
    );

    const result = await resumePendingPrivacyRecoveryLedgerAcks({
      pool: db, env, operationIds: [operationId], now: () => Date.parse('2026-11-18T08:00:00.000Z')
    });
    assert.deepEqual(result, { claimed: 1, acknowledged: 1, deferred: 0, leaseLost: 0 });

    const stored = await db.query(
      `SELECT status, ledger_sequence, ack_attempts, ack_lease_token,
              ack_lease_expires_at, ack_last_error_code
         FROM privacy_recovery_operations WHERE operation_id = $1`,
      [operationId]
    );
    assert.deepEqual(stored.rows[0], {
      status: 'acknowledged',
      ledger_sequence: '1',
      ack_attempts: 1,
      ack_lease_token: null,
      ack_lease_expires_at: null,
      ack_last_error_code: null
    });
    assert.equal(ledger.events.length, 1);

    const second = await resumePendingPrivacyRecoveryLedgerAcks({ pool: db, env, operationIds: [operationId] });
    assert.deepEqual(second, { claimed: 0, acknowledged: 0, deferred: 0, leaseLost: 0 });
    assert.equal(ledger.events.length, 1, 'acknowledged operations must not be redelivered by the ACK repair worker');
  } finally {
    await db.query('DELETE FROM privacy_recovery_operations WHERE operation_id = $1', [operationId]).catch(() => {});
    await db.end();
    await ledger.close().catch(() => {});
  }
});


test('PostgreSQL ACK resumer leaves live leases alone and recovers expired worker leases', {
  skip: !process.env.DATABASE_URL,
  timeout: 30_000
}, async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const operationId = randomUUID();
  const payload = {
    event_id: operationId,
    schema_version: 1,
    event_type: 'private_photo_erasure_requested',
    subject_ref: 'c'.repeat(64),
    resource_ref: 'd'.repeat(64),
    occurred_at: '2026-11-18T08:00:00.000Z'
  };
  const env = {
    NODE_ENV: 'test',
    PRIVACY_RECOVERY_LEDGER_REQUIRED: 'true',
    PRIVACY_RECOVERY_LEDGER_URL: 'https://ledger.example',
    PRIVACY_RECOVERY_LEDGER_HMAC_SECRET: 'test-ledger-hmac-secret-'.padEnd(40, 'x')
  };
  const fetchImpl = async (_url, options) => {
    const event = JSON.parse(options.body);
    return new Response(JSON.stringify({
      accepted: true, event_id: event.event_id, sequence: 17
    }), { status: 201 });
  };

  try {
    await db.query(
      `INSERT INTO privacy_recovery_operations
         (operation_id, event_id, event_payload, ack_lease_token, ack_lease_expires_at)
       VALUES ($1, $1, $2::jsonb, $3, statement_timestamp() + INTERVAL '1 hour')`,
      [operationId, JSON.stringify(payload), randomUUID()]
    );

    const liveLease = await resumePendingPrivacyRecoveryLedgerAcks({ pool: db, env, operationIds: [operationId], fetchImpl });
    assert.deepEqual(liveLease, { claimed: 0, acknowledged: 0, deferred: 0, leaseLost: 0 },
      'a live lease owned by another worker must not be stolen');

    await db.query(
      `UPDATE privacy_recovery_operations
          SET ack_lease_expires_at = statement_timestamp() - INTERVAL '1 second'
        WHERE operation_id = $1`,
      [operationId]
    );
    const recovered = await resumePendingPrivacyRecoveryLedgerAcks({ pool: db, env, operationIds: [operationId], fetchImpl });
    assert.deepEqual(recovered, { claimed: 1, acknowledged: 1, deferred: 0, leaseLost: 0 },
      'a worker restart must recover an expired lease using the same immutable event');
    const stored = await db.query(
      `SELECT status, ledger_sequence, ack_lease_token, ack_lease_expires_at
         FROM privacy_recovery_operations WHERE operation_id = $1`,
      [operationId]
    );
    assert.deepEqual(stored.rows[0], {
      status: 'acknowledged',
      ledger_sequence: '17',
      ack_lease_token: null,
      ack_lease_expires_at: null
    });
  } finally {
    await db.query('DELETE FROM privacy_recovery_operations WHERE operation_id = $1', [operationId]).catch(() => {});
    await db.end();
  }
});

test('concurrent PostgreSQL ACK workers cannot claim the same live operation lease', {
  skip: !process.env.DATABASE_URL,
  timeout: 30_000
}, async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const operationId = randomUUID();
  const payload = {
    event_id: operationId,
    schema_version: 1,
    event_type: 'private_photo_erasure_requested',
    subject_ref: 'e'.repeat(64),
    resource_ref: 'f'.repeat(64),
    occurred_at: '2026-11-18T08:00:00.000Z'
  };
  const env = {
    NODE_ENV: 'test',
    PRIVACY_RECOVERY_LEDGER_REQUIRED: 'true',
    PRIVACY_RECOVERY_LEDGER_URL: 'https://ledger.example',
    PRIVACY_RECOVERY_LEDGER_HMAC_SECRET: 'test-ledger-hmac-secret-'.padEnd(40, 'x')
  };
  let signalFetchStarted;
  const fetchStarted = new Promise(resolve => { signalFetchStarted = resolve; });
  let releaseFetch;
  const fetchGate = new Promise(resolve => { releaseFetch = resolve; });
  const fetchImpl = async (_url, options) => {
    signalFetchStarted();
    await fetchGate;
    const event = JSON.parse(options.body);
    return new Response(JSON.stringify({
      accepted: true, event_id: event.event_id, sequence: 18
    }), { status: 201 });
  };

  try {
    await db.query(
      `INSERT INTO privacy_recovery_operations (operation_id, event_id, event_payload)
       VALUES ($1, $1, $2::jsonb)`,
      [operationId, JSON.stringify(payload)]
    );

    const firstWorker = resumePendingPrivacyRecoveryLedgerAcks({ pool: db, env, operationIds: [operationId], fetchImpl });
    await fetchStarted;
    const secondWorker = await resumePendingPrivacyRecoveryLedgerAcks({
      pool: db, env, operationIds: [operationId],
      fetchImpl: async () => { throw new Error('second worker must not contact Ledger'); }
    });
    assert.deepEqual(secondWorker, { claimed: 0, acknowledged: 0, deferred: 0, leaseLost: 0 },
      'a concurrent worker must observe and respect the first worker lease');

    releaseFetch();
    const firstResult = await firstWorker;
    assert.deepEqual(firstResult, { claimed: 1, acknowledged: 1, deferred: 0, leaseLost: 0 });
    const attempts = await db.query(
      'SELECT ack_attempts, status FROM privacy_recovery_operations WHERE operation_id = $1',
      [operationId]
    );
    assert.deepEqual(attempts.rows[0], { ack_attempts: 1, status: 'acknowledged' });
  } finally {
    releaseFetch?.();
    await db.query('DELETE FROM privacy_recovery_operations WHERE operation_id = $1', [operationId]).catch(() => {});
    await db.end();
  }
});

test('PostgreSQL ACK saga accepts address-draft withdrawal only with its pseudonymized order reference', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await db.connect();
  const operationId = randomUUID();
  const missingResourceId = randomUUID();
  const payload = {
    event_id: operationId,
    schema_version: 1,
    event_type: 'gift_address_draft_consent_withdrawn',
    subject_ref: 'a'.repeat(64),
    resource_ref: 'b'.repeat(64),
    occurred_at: '2026-11-18T08:00:00.000Z'
  };
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO privacy_recovery_operations (operation_id, event_id, event_payload)
       VALUES ($1, $1, $2::jsonb)`,
      [operationId, JSON.stringify(payload)]
    );

    const migrationConstraints = await client.query(
      `SELECT conname
         FROM pg_constraint
        WHERE conrelid = 'privacy_recovery_operations'::regclass
          AND conname IN (
            'privacy_recovery_operations_event_type_check',
            'privacy_recovery_operations_draft_resource_check'
          )
        ORDER BY conname`
    );
    assert.deepEqual(migrationConstraints.rows.map(row => row.conname), [
      'privacy_recovery_operations_draft_resource_check',
      'privacy_recovery_operations_event_type_check'
    ], 'migration 247 must install explicit event-type and address-draft resource constraints');

    const unsupportedId = randomUUID();
    await client.query('SAVEPOINT unsupported_event');
    await assert.rejects(
      client.query(
        `INSERT INTO privacy_recovery_operations (operation_id, event_id, event_payload)
         VALUES ($1, $1, $2::jsonb)`,
        [unsupportedId, JSON.stringify({
          ...payload, event_id: unsupportedId, event_type: 'unrecognized_privacy_event'
        })]
      ),
      error => error.code === '23514',
      'ACK saga must reject event types outside its allowlist'
    );
    await client.query('ROLLBACK TO SAVEPOINT unsupported_event');

    const malformedId = randomUUID();
    await client.query('SAVEPOINT malformed_resource');
    await assert.rejects(
      client.query(
        `INSERT INTO privacy_recovery_operations (operation_id, event_id, event_payload)
         VALUES ($1, $1, $2::jsonb)`,
        [malformedId, JSON.stringify({
          ...payload, event_id: malformedId, resource_ref: 'z'.repeat(64)
        })]
      ),
      error => error.code === '23514',
      'address-draft resource reference must be 64 lowercase hexadecimal characters'
    );
    await client.query('ROLLBACK TO SAVEPOINT malformed_resource');

    await client.query('SAVEPOINT missing_resource');
    await assert.rejects(
      client.query(
        `INSERT INTO privacy_recovery_operations (operation_id, event_id, event_payload)
         VALUES ($1, $1, $2::jsonb)`,
        [missingResourceId, JSON.stringify({
          ...payload, event_id: missingResourceId, resource_ref: undefined
        })]
      ),
      error => error.code === '23514'
    );
    await client.query('ROLLBACK TO SAVEPOINT missing_resource');
    await client.query('ROLLBACK');
  } finally {
    client.release();
    await db.end();
  }
});


test('expired ACK lease takeover is safe when the stale worker returns after the replacement worker ACKs', {
  skip: !process.env.DATABASE_URL,
  timeout: 30_000
}, async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const ledger = await startTestPrivacyRecoveryLedger();
  const operationId = randomUUID();
  const payload = {
    event_id: operationId,
    schema_version: 1,
    event_type: 'private_photo_erasure_requested',
    subject_ref: 'f'.repeat(64),
    resource_ref: 'e'.repeat(64),
    occurred_at: '2026-11-20T08:00:00.000Z'
  };
  const env = {
    NODE_ENV: 'test',
    PRIVACY_RECOVERY_LEDGER_REQUIRED: 'true',
    PRIVACY_RECOVERY_LEDGER_URL: ledger.url,
    PRIVACY_RECOVERY_LEDGER_HMAC_SECRET: 'test-ledger-hmac-secret-'.padEnd(40, 'x')
  };
  let signalFirstFetch;
  const firstFetchStarted = new Promise(resolve => { signalFirstFetch = resolve; });
  let releaseFirstFetch;
  const firstFetchGate = new Promise(resolve => { releaseFirstFetch = resolve; });

  try {
    await db.query(
      `INSERT INTO privacy_recovery_operations (operation_id, event_id, event_payload)
       VALUES ($1, $1, $2::jsonb)`,
      [operationId, JSON.stringify(payload)]
    );

    const staleWorker = resumePendingPrivacyRecoveryLedgerAcks({
      pool: db, env, operationIds: [operationId], leaseMs: 10_000,
      fetchImpl: async (url, options) => {
        signalFirstFetch();
        await firstFetchGate;
        return fetch(url, options);
      }
    });
    await firstFetchStarted;

    // Simulate the first process being paused beyond its lease while its HTTP
    // request is still in flight. A replacement worker may now claim the row.
    await db.query(
      `UPDATE privacy_recovery_operations
          SET ack_lease_expires_at = statement_timestamp() - INTERVAL '1 second'
        WHERE operation_id = $1`,
      [operationId]
    );

    const replacement = await resumePendingPrivacyRecoveryLedgerAcks({
      pool: db, env, operationIds: [operationId], fetchImpl: fetch
    });
    assert.deepEqual(replacement, { claimed: 1, acknowledged: 1, deferred: 0, leaseLost: 0 });

    releaseFirstFetch();
    const staleResult = await staleWorker;
    assert.deepEqual(staleResult, { claimed: 1, acknowledged: 0, deferred: 0, leaseLost: 1 },
      'the expired worker must not overwrite the replacement worker ACK');

    const stored = await db.query(
      `SELECT status, ledger_sequence, ack_attempts, ack_lease_token
         FROM privacy_recovery_operations WHERE operation_id = $1`,
      [operationId]
    );
    assert.deepEqual(stored.rows[0], {
      status: 'acknowledged',
      ledger_sequence: '1',
      ack_attempts: 2,
      ack_lease_token: null
    });
    assert.equal(ledger.events.length, 1,
      'both deliveries must resolve to one durable Ledger event and sequence');
  } finally {
    releaseFirstFetch?.();
    await db.query('DELETE FROM privacy_recovery_operations WHERE operation_id = $1', [operationId]).catch(() => {});
    await db.end();
    await ledger.close().catch(() => {});
  }
});
