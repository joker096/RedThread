import test from 'node:test';
import assert from 'node:assert/strict';
import { stagePrivacyRecoveryEvents } from './privacyRecoveryReplay.js';

const targetEnv = {
  NODE_ENV: 'test',
  PRIVACY_RECOVERY_RESTORE_ISOLATED: 'true',
  PRIVACY_RECOVERY_RESTORE_DATABASE_NAME: 'vow_restore_test',
  PRIVACY_RECOVERY_RESTORE_DATABASE_ROLE: 'vow_restore_runner',
  PRIVACY_RECOVERY_RESTORE_CONFIRMATION: 'ISOLATED_RESTORE_ONLY'
};

async function stage(client, options) {
  return stagePrivacyRecoveryEvents(client, { ...options, env: targetEnv });
}

const event = (sequence, overrides = {}) => ({
  sequence,
  event_id: `123e4567-e89b-42d3-a456-42661417400${sequence}`,
  schema_version: 1,
  event_type: 'account_erasure_requested',
  subject_ref: 'a'.repeat(64),
  resource_ref: null,
  occurred_at: '2026-11-14T08:00:00.000Z',
  received_at: '2026-11-14T08:00:01.000Z',
  ...overrides
});

function fakeClient(existingRows = [], identity = {}) {
  const rows = [...existingRows];
  const calls = [];
  return {
    rows, calls,
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes('SELECT current_database() AS database_name')) return { rowCount: 1, rows: [{ database_name: identity.databaseName || targetEnv.PRIVACY_RECOVERY_RESTORE_DATABASE_NAME, database_role: identity.databaseRole || targetEnv.PRIVACY_RECOVERY_RESTORE_DATABASE_ROLE }] };
      if (sql.includes('FROM pg_roles r')) return { rowCount: 1, rows: [{
        rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false,
        rolbypassrls: false, rolcanlogin: true, has_role_memberships: false,
        has_relation_write_privileges: false, has_column_write_privileges: false, has_sequence_write_privileges: false,
        has_schema_create_privileges: false, has_database_create_privilege: false
      }] };
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('pg_advisory_xact_lock')) return { rowCount: null, rows: [] };
      if (sql.includes('INSERT INTO privacy_recovery_events')) {
        const [sequence, eventId, schemaVersion, eventType, subjectRef, resourceRef, occurredAt, receivedAt] = values;
        const found = rows.some(row => row.ledger_sequence === sequence || row.event_id === eventId);
        if (found) return { rowCount: 0, rows: [] };
        rows.push({
          ledger_sequence: sequence, event_id: eventId, schema_version: schemaVersion,
          event_type: eventType, subject_ref: subjectRef, resource_ref: resourceRef,
          occurred_at: occurredAt, received_at: receivedAt
        });
        return { rowCount: 1, rows: [{ ledger_sequence: sequence }] };
      }
      if (sql.includes('SELECT ledger_sequence')) {
        const [sequence, eventId] = values;
        const found = rows.filter(row => row.ledger_sequence === sequence || row.event_id === eventId);
        return { rowCount: found.length, rows: found };
      }
      throw new Error('unexpected_query');
    }
  };
}

test('stages only events newer than the restored snapshot watermark', async () => {
  const client = fakeClient();
  const result = await stage(client, {
    snapshotLedgerSequence: 1, events: [event(1), event(2), event(3)]
  });
  assert.deepEqual(result, { snapshotLedgerSequence: 1, stagedCount: 2, alreadyPresentCount: 0, throughSequence: 3 });
  assert.deepEqual(client.rows.map(row => row.ledger_sequence), [2, 3]);
  assert.match(client.calls[0].sql, /current_database\(\)/);
  assert.match(client.calls[1].sql, /FROM pg_roles r/);
  assert.equal(client.calls[2].sql, 'BEGIN');
  assert.equal(client.calls.at(-1).sql, 'COMMIT');
  assert.equal(client.calls.filter(call => call.sql.includes('pg_advisory_xact_lock')).length, 4);
  assert.equal(client.calls.some(call => call.sql.includes('FOR SHARE')), false);
});

test('repeated staging is idempotent when existing rows match exactly', async () => {
  const existing = [{
    ledger_sequence: 2, event_id: event(2).event_id, schema_version: 1,
    event_type: 'account_erasure_requested', subject_ref: 'a'.repeat(64),
    resource_ref: null, occurred_at: new Date(event(2).occurred_at),
    received_at: new Date(event(2).received_at)
  }];
  const client = fakeClient(existing);
  const result = await stage(client, {
    snapshotLedgerSequence: 1, events: [event(1), event(2)]
  });
  assert.equal(result.stagedCount, 0);
  assert.equal(result.alreadyPresentCount, 1);
  assert.equal(client.calls.at(-1).sql, 'COMMIT');
});

test('rejects invalid sequence, duplicate IDs and snapshot watermark ahead of export', async () => {
  const client = fakeClient();
  await assert.rejects(stage(client, {
    snapshotLedgerSequence: 0, events: [event(2)]
  }), /archive_invalid/);
  await assert.rejects(stage(client, {
    snapshotLedgerSequence: 0, events: [event(1), event(2, { event_id: event(1).event_id })]
  }), /archive_invalid/);
  await assert.rejects(stage(client, {
    snapshotLedgerSequence: 2, events: [event(1)]
  }), /watermark_ahead/);
  assert.equal(client.calls.length, 0);
});

test('rolls back when an existing sequence or event ID conflicts', async () => {
  const client = fakeClient([{
    ledger_sequence: 2, event_id: event(2).event_id, schema_version: 1,
    event_type: 'account_erasure_requested', subject_ref: 'b'.repeat(64),
    resource_ref: null, occurred_at: new Date(event(2).occurred_at),
    received_at: new Date(event(2).received_at)
  }]);
  await assert.rejects(stage(client, {
    snapshotLedgerSequence: 1, events: [event(1), event(2)]
  }), /conflicting_existing_event/);
  assert.equal(client.calls.at(-1).sql, 'ROLLBACK');
});


test('stages gift consent withdrawal as an auditable event but rejects unapproved gift event types', async () => {
  const giftWithdrawal = event(1, {
    event_type: 'gift_order_consent_withdrawn',
    resource_ref: 'e'.repeat(64)
  });
  const client = fakeClient();
  const result = await stage(client, {
    snapshotLedgerSequence: 0,
    events: [giftWithdrawal]
  });
  assert.equal(result.stagedCount, 1);
  assert.equal(client.rows[0].event_type, 'gift_order_consent_withdrawn');
  assert.equal(client.rows[0].resource_ref, 'e'.repeat(64));

  const unsupportedClient = fakeClient();
  await assert.rejects(stage(unsupportedClient, {
    snapshotLedgerSequence: 0,
    events: [event(1, { event_type: 'gift_address_draft_submitted' })]
  }), /archive_invalid/);
  assert.equal(unsupportedClient.calls.length, 0, 'unapproved event types must fail before opening a transaction');
});

test('stages the new address-draft consent event without granting replay authority', async () => {
  const client = fakeClient();
  const result = await stage(client, {
    snapshotLedgerSequence: 0,
    events: [event(1, {
      event_type: 'gift_address_draft_consent_withdrawn',
      resource_ref: 'f'.repeat(64)
    })]
  });
  assert.equal(result.stagedCount, 1);
  assert.equal(client.rows[0].event_type, 'gift_address_draft_consent_withdrawn');
});

test('rejects address-draft consent withdrawal without a resource reference before touching the database', async () => {
  const client = fakeClient();
  await assert.rejects(stage(client, {
    snapshotLedgerSequence: 0,
    events: [event(1, {
      event_type: 'gift_address_draft_consent_withdrawn',
      resource_ref: null
    })]
  }), /archive_invalid/);
  assert.equal(client.calls.length, 0);
});

test('refuses to stage when the connected PostgreSQL database or role differs from the explicit isolated target', async () => {
  for (const client of [
    fakeClient([], { databaseName: 'vow_production' }),
    fakeClient([], { databaseRole: 'vow_api' })
  ]) {
    await assert.rejects(stage(client, {
      snapshotLedgerSequence: 0,
      events: [event(1)]
    }), /database_identity_mismatch/);
    assert.equal(client.rows.length, 0);
    assert.equal(client.calls.some(call => call.sql.includes('INSERT INTO privacy_recovery_events')), false);
    assert.equal(client.calls.some(call => call.sql === 'BEGIN'), false);
  }
});

test('refuses to stage when isolated restore confirmation is absent', async () => {
  const client = fakeClient();
  await assert.rejects(stagePrivacyRecoveryEvents(client, {
    snapshotLedgerSequence: 0,
    events: [event(1)],
    env: { ...targetEnv, PRIVACY_RECOVERY_RESTORE_CONFIRMATION: '' }
  }), /target_not_explicitly_configured/);
  assert.equal(client.calls.length, 0);
});
