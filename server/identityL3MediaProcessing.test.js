import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  IdentityL3MediaProcessingError,
  processIdentityL3Media,
  validateIdentityL3Probe
} from './identityL3MediaProcessing.js';

const mp4Probe = {
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '42.25' },
  streams: [{ codec_type: 'video', codec_name: 'h264' }, { codec_type: 'audio', codec_name: 'aac' }]
};

test('L3 media probe accepts only supported MP4/H.264 with 30–60 second duration', () => {
  assert.equal(validateIdentityL3Probe(mp4Probe, 'video/mp4'), 42);
  for (const duration of ['29.99', '60.01', 'NaN']) {
    assert.throws(
      () => validateIdentityL3Probe({ ...mp4Probe, format: { ...mp4Probe.format, duration } }, 'video/mp4'),
      error => error instanceof IdentityL3MediaProcessingError && error.code === 'l3_media_format_or_duration_invalid'
    );
  }
});

test('L3 media probe rejects MIME spoofing, unsupported codecs and extra streams', () => {
  assert.throws(
    () => validateIdentityL3Probe(mp4Probe, 'video/webm'),
    error => error.code === 'l3_media_format_or_codec_invalid'
  );
  assert.throws(
    () => validateIdentityL3Probe({ ...mp4Probe, streams: [{ codec_type: 'video', codec_name: 'mpeg4' }] }, 'video/mp4'),
    error => error.code === 'l3_media_format_or_codec_invalid'
  );
  assert.throws(
    () => validateIdentityL3Probe({ ...mp4Probe, streams: [...mp4Probe.streams, { codec_type: 'subtitle', codec_name: 'mov_text' }] }, 'video/mp4'),
    error => error.code === 'l3_media_format_or_duration_invalid'
  );
});

test('L3 media processing requires both actual probe validation and a clean malware scan', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'vow-l3-test-'));
  const events = [];
  try {
    const result = await processIdentityL3Media({
      objectKey: 'opaque-object',
      storageRoot: '/private',
      encryptionKey: 'not-used-by-test-adapter',
      declaredMimeType: 'video/mp4',
      tempRoot,
      openDecryptedStream: async () => Readable.from([Buffer.from('encrypted-content-decoded')]),
      probe: async filePath => {
        events.push('probe');
        assert.ok((await stat(filePath)).size > 0);
        return mp4Probe;
      },
      scanner: async filePath => {
        events.push('scan');
        assert.equal((await readFile(filePath)).toString(), 'encrypted-content-decoded');
        return { clean: true };
      }
    });
    assert.deepEqual(result, { durationSeconds: 42, sizeBytes: Buffer.byteLength('encrypted-content-decoded') });
    assert.deepEqual(events, ['probe', 'scan']);
    assert.deepEqual(await readdir(tempRoot), [], 'plaintext staging file must be removed');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('L3 media processing fails closed when scanner is unavailable and removes plaintext staging', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'vow-l3-test-'));
  try {
    await assert.rejects(
      processIdentityL3Media({
        objectKey: 'opaque-object',
        storageRoot: '/private',
        encryptionKey: 'not-used-by-test-adapter',
        declaredMimeType: 'video/mp4',
        tempRoot,
        openDecryptedStream: async () => Readable.from([Buffer.from('decoded')]),
        probe: async () => mp4Probe,
        scanner: async () => { throw new IdentityL3MediaProcessingError('l3_media_scanner_unavailable'); }
      }),
      error => error.code === 'l3_media_scanner_unavailable'
    );
    assert.deepEqual(await readdir(tempRoot), [], 'scanner failure must not leave plaintext staging files');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('L3 media processing fails closed when ffprobe cannot be run', async () => {
  await assert.rejects(
    processIdentityL3Media({
      objectKey: 'opaque-object',
      storageRoot: '/private',
      encryptionKey: 'not-used-by-test-adapter',
      declaredMimeType: 'video/mp4',
      openDecryptedStream: async () => Readable.from([Buffer.from('decoded')]),
      probe: async () => { throw new IdentityL3MediaProcessingError('l3_media_probe_unavailable'); },
      scanner: async () => ({ clean: true })
    }),
    error => error.code === 'l3_media_probe_unavailable'
  );
});
