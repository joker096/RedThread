import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import {
  buildIdentityL3FfprobeArgs,
  IdentityL3MediaProcessingError,
  processIdentityL3Media,
  scanIdentityL3FileWithClamD,
  validateIdentityL3Probe
} from './identityL3MediaProcessing.js';

const mp4Probe = {
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '42.25' },
  streams: [{ codec_type: 'video', codec_name: 'h264' }, { codec_type: 'audio', codec_name: 'aac' }]
};

test('ffprobe is restricted to local file protocols for untrusted media', () => {
  const filePath = '/run/identity-l3-tmp/media.bin';
  const args = buildIdentityL3FfprobeArgs(filePath);
  assert.ok(args.includes('-protocol_whitelist'));
  assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file,pipe');
  assert.equal(args.at(-1), filePath);
  assert.throws(() => buildIdentityL3FfprobeArgs(''), TypeError);
});

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
        const stagedStat = await stat(filePath);
        assert.ok(stagedStat.size > 0);
        assert.equal(stagedStat.mode & 0o077, 0, 'plaintext staging file must be owner-only');
        return mp4Probe;
      },
      scanner: async filePath => {
        events.push('scan');
        assert.equal((await readFile(filePath)).toString(), 'encrypted-content-decoded');
        return { clean: true };
      }
    });
    assert.deepEqual(result, { durationSeconds: 42, sizeBytes: Buffer.byteLength('encrypted-content-decoded') });
    assert.deepEqual(events, ['scan', 'probe']);
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

test('L3 media processing never invokes ffprobe when ClamAV detects malware', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'vow-l3-test-'));
  let probeCalled = false;
  try {
    await assert.rejects(
      processIdentityL3Media({
        objectKey: 'opaque-object',
        storageRoot: '/private',
        encryptionKey: 'not-used-by-test-adapter',
        declaredMimeType: 'video/mp4',
        tempRoot,
        openDecryptedStream: async () => Readable.from([Buffer.from('malicious-media')]),
        scanner: async () => {
          throw new IdentityL3MediaProcessingError('l3_media_malware_detected');
        },
        probe: async () => {
          probeCalled = true;
          return mp4Probe;
        }
      }),
      error => error.code === 'l3_media_malware_detected'
    );
    assert.equal(probeCalled, false, 'ffprobe must not parse media rejected by ClamAV');
    assert.deepEqual(await readdir(tempRoot), [], 'rejected plaintext staging must be removed');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('L3 media processing fails closed when ffprobe cannot be run', async () => {
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
        probe: async () => { throw new IdentityL3MediaProcessingError('l3_media_probe_unavailable'); },
        scanner: async () => ({ clean: true })
      }),
      error => error.code === 'l3_media_probe_unavailable'
    );
    assert.deepEqual(await readdir(tempRoot), []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('L3 media processing refuses to fall back to the container default /tmp', async () => {
  let opened = false;
  await assert.rejects(
    processIdentityL3Media({
      objectKey: 'opaque-object',
      storageRoot: '/private',
      encryptionKey: 'not-used-by-test-adapter',
      declaredMimeType: 'video/mp4',
      openDecryptedStream: async () => {
        opened = true;
        return Readable.from([Buffer.from('decoded')]);
      },
      probe: async () => mp4Probe,
      scanner: async () => ({ clean: true })
    }),
    error => error.code === 'l3_media_temp_storage_not_configured'
  );
  assert.equal(opened, false, 'no decrypted bytes may be opened without an explicit private scratch path');
});


async function withFakeClamD(responseParts, callback) {
  const received = [];
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    let commandRead = false;
    let payloadLength = null;
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!commandRead) {
        const commandEnd = buffer.indexOf(0);
        if (commandEnd === -1) return;
        assert.equal(buffer.subarray(0, commandEnd).toString(), 'zINSTREAM');
        buffer = buffer.subarray(commandEnd + 1);
        commandRead = true;
      }
      while (commandRead) {
        if (payloadLength === null) {
          if (buffer.length < 4) return;
          payloadLength = buffer.readUInt32BE(0);
          buffer = buffer.subarray(4);
          if (payloadLength === 0) {
            for (const part of responseParts) socket.write(part);
            return;
          }
        }
        if (buffer.length < payloadLength) return;
        received.push(buffer.subarray(0, payloadLength));
        buffer = buffer.subarray(payloadLength);
        payloadLength = null;
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    await callback(server.address().port, received);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('ClamAV INSTREAM sends NUL-framed command and accepts fragmented clean response', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vow-clamd-test-'));
  const filePath = path.join(directory, 'sample.bin');
  try {
    await writeFile(filePath, Buffer.from('known-clean-payload'));
    await withFakeClamD([Buffer.from('stream: O'), Buffer.from('K\0')], async (port, received) => {
      await scanIdentityL3FileWithClamD(filePath, { host: '127.0.0.1', port, timeoutMs: 2000 });
      assert.equal(Buffer.concat(received).toString(), 'known-clean-payload');
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ClamAV INSTREAM rejects a fragmented malware FOUND response', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vow-clamd-test-'));
  const filePath = path.join(directory, 'sample.bin');
  try {
    await writeFile(filePath, Buffer.from('infected-payload'));
    await withFakeClamD([Buffer.from('stream: Eicar-Test'), Buffer.from('-Signature FOUND\0')], async (port) => {
      await assert.rejects(
        scanIdentityL3FileWithClamD(filePath, { host: '127.0.0.1', port, timeoutMs: 2000 }),
        error => error.code === 'l3_media_malware_detected'
      );
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
