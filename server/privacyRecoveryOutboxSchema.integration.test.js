import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { enqueuePrivacyRecoveryEvent } from './privacyRecoveryOutbox.js';

const { Pool } = pg;
const env = {
  NODE_ENV: 'production',
  PRIVACY_RECOVERY_LEDGER_REQUIRED: 'true',
  PRIVACY_RECOVERY_LEDGER_URL: 'https://ledger.example',
  PRIVACY_RECOVERY_LEDGER_HMAC_SECRET: 'auth-secret-at-least-32-characters-long',
  PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY: 'pseudonym-secret-at-least-32-characters'
};

test('domain rollback atomically removes its privacy recovery outbox event', {
  skip: !process.env.DATABASE_URL ? 'DATABASE_URL is not configured' : false,
  timeout: 15_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const eventId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const queued = await enqueuePrivacyRecoveryEvent(client, {
      eventType: 'account_erasure_requested',
      userId: randomUUID(),
      eventId
    }, { env });
    assert.equal(queued.eventId, eventId);
    const inside = await client.query(
      'SELECT status, event_payload->>\'event_id\' AS payload_event_id FROM privacy_recovery_ledger_outbox WHERE event_id = $1',
      [eventId]
    );
    assert.equal(inside.rowCount, 1);
    assert.equal(inside.rows[0].status, 'pending');
    assert.equal(inside.rows[0].payload_event_id, eventId);

    const outsideBeforeRollback = await pool.query(
      'SELECT 1 FROM privacy_recovery_ledger_outbox WHERE event_id = $1',
      [eventId]
    );
    assert.equal(outsideBeforeRollback.rowCount, 0,
      'uncommitted domain event must not be visible to the worker');

    await client.query('ROLLBACK');
    const afterRollback = await pool.query(
      'SELECT 1 FROM privacy_recovery_ledger_outbox WHERE event_id = $1',
      [eventId]
    );
    assert.equal(afterRollback.rowCount, 0,
      'rollback must remove the outbox row together with the domain mutation');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});

test('outbox schema rejects malformed payloads and immutable event mutation', {
  skip: !process.env.DATABASE_URL ? 'DATABASE_URL is not configured' : false,
  timeout: 15_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const eventId = randomUUID();
  const payload = {
    event_id: eventId,
    schema_version: 1,
    event_type: 'account_erasure_requested',
    subject_ref: 'a'.repeat(64),
    occurred_at: new Date().toISOString()
  };
  try {
    await assert.rejects(
      pool.query(
        'INSERT INTO privacy_recovery_ledger_outbox (event_id, event_payload) VALUES ($1, $2::jsonb)',
        [randomUUID(), JSON.stringify(payload)]
      ),
      error => error.code === '23514',
      'event UUID and payload UUID must match'
    );
    await pool.query(
      'INSERT INTO privacy_recovery_ledger_outbox (event_id, event_payload) VALUES ($1, $2::jsonb)',
      [eventId, JSON.stringify(payload)]
    );
    await assert.rejects(
      pool.query(
        'UPDATE privacy_recovery_ledger_outbox SET event_payload = jsonb_set(event_payload, \'{event_type}\', \'"ad_consent_revoked"\'::jsonb) WHERE event_id = $1',
        [eventId]
      ),
      error => error.code === '55000',
      'event payload must remain immutable after enqueue'
    );
  } finally {
    await pool.query('DELETE FROM privacy_recovery_ledger_outbox WHERE event_id = $1', [eventId]).catch(() => {});
    await pool.end();
  }
});


test('outbox accepts address-draft withdrawal only with a valid pseudonymized order reference', {
  skip: !process.env.DATABASE_URL ? 'DATABASE_URL is not configured' : false,
  timeout: 15_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const eventId = randomUUID();
  const validPayload = {
    eventType: 'gift_address_draft_consent_withdrawn',
    userId: randomUUID(),
    resourceId: randomUUID(),
    eventId
  };
  try {
    const queued = await enqueuePrivacyRecoveryEvent(pool, validPayload, { env });
    assert.equal(queued.queued, true);
    assert.equal(queued.eventId, eventId);

    const stored = await pool.query(
      'SELECT event_payload FROM privacy_recovery_ledger_outbox WHERE event_id = $1',
      [eventId]
    );
    assert.equal(stored.rowCount, 1);
    assert.match(stored.rows[0].event_payload.resource_ref, /^[a-f0-9]{64}$/);

    const migrationConstraints = await pool.query(
      `SELECT conname
         FROM pg_constraint
        WHERE conrelid = 'privacy_recovery_ledger_outbox'::regclass
          AND conname IN (
            'privacy_recovery_outbox_event_type_allowed_check',
            'privacy_recovery_outbox_address_draft_resource_check'
          )
        ORDER BY conname`
    );
    assert.deepEqual(migrationConstraints.rows.map(row => row.conname), [
      'privacy_recovery_outbox_address_draft_resource_check',
      'privacy_recovery_outbox_event_type_allowed_check'
    ], 'migration 248 must install both explicit event-type and address-draft resource constraints');

    const requiredPayloadConstraint = await pool.query(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'privacy_recovery_ledger_outbox'::regclass
          AND conname = 'privacy_recovery_outbox_required_payload_fields_check'`
    );
    assert.equal(requiredPayloadConstraint.rowCount, 1,
      'migration 249 must require identity, schema version, subject and timestamp fields');

    const unsupportedEventId = randomUUID();
    const unsupportedEventPayload = {
      event_id: unsupportedEventId,
      schema_version: 1,
      event_type: 'unrecognized_privacy_event',
      subject_ref: 'c'.repeat(64),
      occurred_at: new Date().toISOString()
    };
    await assert.rejects(
      pool.query(
        'INSERT INTO privacy_recovery_ledger_outbox (event_id, event_payload) VALUES ($1, $2::jsonb)',
        [unsupportedEventId, JSON.stringify(unsupportedEventPayload)]
      ),
      error => error.code === '23514',
      'outbox must reject event types outside the migration allowlist'
    );

    for (const field of ['event_id', 'schema_version', 'subject_ref']) {
      const invalidId = randomUUID();
      const invalidPayload = {
        event_id: invalidId,
        schema_version: 1,
        event_type: 'account_erasure_requested',
        subject_ref: 'e'.repeat(64),
        occurred_at: new Date().toISOString()
      };
      delete invalidPayload[field];
      await assert.rejects(
        pool.query(
          'INSERT INTO privacy_recovery_ledger_outbox (event_id, event_payload) VALUES ($1, $2::jsonb)',
          [invalidId, JSON.stringify(invalidPayload)]
        ),
        error => error.code === '23514',
        `outbox must reject payloads missing ${field}`
      );
    }

    const missingEventTypeId = randomUUID();
    const missingEventTypePayload = {
      event_id: missingEventTypeId,
      schema_version: 1,
      subject_ref: 'd'.repeat(64),
      occurred_at: new Date().toISOString()
    };
    await assert.rejects(
      pool.query(
        'INSERT INTO privacy_recovery_ledger_outbox (event_id, event_payload) VALUES ($1, $2::jsonb)',
        [missingEventTypeId, JSON.stringify(missingEventTypePayload)]
      ),
      error => error.code === '23514',
      'outbox must reject payloads that omit event_type'
    );

    const missingResourceId = randomUUID();
    const missingResourcePayload = {
      event_id: missingResourceId,
      schema_version: 1,
      event_type: 'gift_address_draft_consent_withdrawn',
      subject_ref: 'b'.repeat(64),
      occurred_at: new Date().toISOString()
    };
    await assert.rejects(
      pool.query(
        'INSERT INTO privacy_recovery_ledger_outbox (event_id, event_payload) VALUES ($1, $2::jsonb)',
        [missingResourceId, JSON.stringify(missingResourcePayload)]
      ),
      error => error.code === '23514',
      'address-draft withdrawal must include a resource reference'
    );

    const malformedResourceId = randomUUID();
    const malformedResourcePayload = {
      ...missingResourcePayload,
      event_id: malformedResourceId,
      resource_ref: 'not-a-pseudonym'
    };
    await assert.rejects(
      pool.query(
        'INSERT INTO privacy_recovery_ledger_outbox (event_id, event_payload) VALUES ($1, $2::jsonb)',
        [malformedResourceId, JSON.stringify(malformedResourcePayload)]
      ),
      error => error.code === '23514',
      'address-draft withdrawal must use a 64-hex pseudonymized resource reference'
    );
  } finally {
    await pool.query('DELETE FROM privacy_recovery_ledger_outbox WHERE event_id = $1', [eventId]).catch(() => {});
    await pool.end();
  }
});
