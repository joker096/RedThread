import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { verifyLedgerExportStream } from './verify-privacy-ledger-export.mjs';

const event = (sequence, overrides = {}) => ({
  sequence,
  event_id: '123e4567-e89b-42d3-a456-42661417400' + sequence,
  schema_version: 1,
  event_type: 'account_erasure_requested',
  subject_ref: 'a'.repeat(64),
  resource_ref: null,
  occurred_at: '2026-11-14T08:00:00.000Z',
  received_at: '2026-11-14T08:00:01.000Z',
  ...overrides
});
const manifest = (count) => ({
  record_type: 'vow_privacy_ledger_export',
  schema_version: 1,
  exported_at: '2026-11-14T08:01:00.000Z',
  first_sequence: count ? 1 : 0,
  last_sequence: count,
  event_count: count
});
const streamOf = (...records) => Readable.from(records.map(record => JSON.stringify(record) + '\n'));

test('validates manifest and complete contiguous event stream', async () => {
  const result = await verifyLedgerExportStream(streamOf(manifest(2), event(1), event(2)));
  assert.equal(result.firstSequence, 1);
  assert.equal(result.lastSequence, 2);
  assert.equal(result.eventCount, 2);
});

test('accepts an empty export with a zero watermark', async () => {
  const result = await verifyLedgerExportStream(streamOf(manifest(0)));
  assert.equal(result.eventCount, 0);
  assert.equal(result.lastSequence, 0);
});

test('rejects sequence gaps, duplicate event IDs and unsupported event types', async () => {
  await assert.rejects(verifyLedgerExportStream(streamOf(manifest(2), event(2))), /event_invalid/);
  await assert.rejects(verifyLedgerExportStream(streamOf(manifest(2), event(1), event(2, { event_id: event(1).event_id }))), /event_invalid/);
  await assert.rejects(verifyLedgerExportStream(streamOf(manifest(1), event(1, { event_type: 'unknown_event' }))), /event_invalid/);
});

test('rejects incomplete count, malformed manifest and invalid JSON', async () => {
  await assert.rejects(verifyLedgerExportStream(streamOf(manifest(2), event(1))), /incomplete/);
  await assert.rejects(verifyLedgerExportStream(streamOf({ ...manifest(0), last_sequence: 1 })), /manifest_invalid/);
  await assert.rejects(verifyLedgerExportStream(Readable.from(['not-json\n'])), /invalid_json/);
  await assert.rejects(verifyLedgerExportStream(Readable.from([])), /manifest_missing/);
});
