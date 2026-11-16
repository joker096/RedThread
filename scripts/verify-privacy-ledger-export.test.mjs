import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyLedgerExportStream, verifyEncryptedLedgerExport } from './verify-privacy-ledger-export.mjs';

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


test('verifies ciphertext checksum and decrypts through a pipe without plaintext files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vow-ledger-verify-'));
  const archivePath = path.join(directory, 'ledger.ndjson.age');
  const identityFile = path.join(directory, 'identity.txt');
  const ciphertext = Buffer.from('synthetic encrypted bytes');
  const plaintext = [manifest(1), event(1)].map(row => JSON.stringify(row)).join('\n') + '\n';
  const digest = createHash('sha256').update(ciphertext).digest('hex');
  await writeFile(archivePath, ciphertext, { mode: 0o600 });
  await writeFile(identityFile, 'AGE-SECRET-KEY-1TEST', { mode: 0o600 });
  await chmod(identityFile, 0o600);
  await writeFile(archivePath + '.sha256', digest + '  ledger.ndjson.age\n', { mode: 0o600 });

  let invoked = false;
  const spawnImpl = (command, args, options) => {
    invoked = true;
    assert.equal(command, 'age');
    assert.equal(args[0], '--decrypt');
    assert.equal(options.stdio[1], 'pipe');
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.stdout.destroy();
    queueMicrotask(() => {
      child.stdout.end(plaintext);
      child.emit('close', 0);
    });
    return child;
  };

  try {
    const result = await verifyEncryptedLedgerExport({ archivePath, identityFile, spawnImpl });
    assert.equal(invoked, true);
    assert.equal(result.eventCount, 1);
    assert.equal(result.sha256, digest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects a tampered ciphertext before invoking age', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vow-ledger-tamper-'));
  const archivePath = path.join(directory, 'ledger.ndjson.age');
  const identityFile = path.join(directory, 'identity.txt');
  await writeFile(archivePath, 'changed ciphertext', { mode: 0o600 });
  await writeFile(identityFile, 'AGE-SECRET-KEY-1TEST', { mode: 0o600 });
  await writeFile(archivePath + '.sha256', '0'.repeat(64) + '  ledger.ndjson.age\n', { mode: 0o600 });
  let invoked = false;
  try {
    await assert.rejects(
      verifyEncryptedLedgerExport({ archivePath, identityFile, spawnImpl: () => { invoked = true; } }),
      /checksum_mismatch/
    );
    assert.equal(invoked, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
