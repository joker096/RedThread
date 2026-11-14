import test from 'node:test';
import assert from 'node:assert/strict';
import { stagePrivacyRecoveryEvents } from './privacyRecoveryReplay.js';

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

function fakeClient(existingRows = []) {
  const rows = [...existingRows];
  const calls = [];
  return {
    rows, calls,
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: null, rows: [] };
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
  const result = await stagePrivacyRecoveryEvents(client, {
    snapshotLedgerSequence: 1, events: [event(1), event(2), event(3)]
  });
  assert.deepEqual(result, { snapshotLedgerSequence: 1, stagedCount: 2, throughSequence: 3 });
  assert.deepEqual(client.rows.map(row => row.ledger_sequence), [2, 3]);
  assert.equal(client.calls[0].sql, 'BEGIN');
  assert.equal(client.calls.at(-1).sql, 'COMMIT');
});

test('repeated staging is idempotent when existing rows match exactly', async () => {
  const existing = [{
    ledger_sequence: 2, event_id: event(2).event_id, schema_version: 1,
    event_type: 'account_erasure_requested', subject_ref: 'a'.repeat(64),
    resource_ref: null, occurred_at: new Date(event(2).occurred_at),
    received_at: new Date(event(2).received_at)
  }];
  const client = fakeClient(existing);
  const result = await stagePrivacyRecoveryEvents(client, {
    snapshotLedgerSequence: 1, events: [event(1), event(2)]
  });
  assert.equal(result.stagedCount, 1);
  assert.equal(client.calls.at(-1).sql, 'COMMIT');
});

test('rejects invalid sequence, duplicate IDs and snapshot watermark ahead of export', async () => {
  const client = fakeClient();
  await assert.rejects(stagePrivacyRecoveryEvents(client, {
    snapshotLedgerSequence: 0, events: [event(2)]
  }), /archive_invalid/);
  await assert.rejects(stagePrivacyRecoveryEvents(client, {
    snapshotLedgerSequence: 0, events: [event(1), event(2, { event_id: event(1).event_id })]
  }), /archive_invalid/);
  await assert.rejects(stagePrivacyRecoveryEvents(client, {
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
  await assert.rejects(stagePrivacyRecoveryEvents(client, {
    snapshotLedgerSequence: 1, events: [event(1), event(2)]
  }), /conflicting_existing_event/);
  assert.equal(client.calls.at(-1).sql, 'ROLLBACK');
});
