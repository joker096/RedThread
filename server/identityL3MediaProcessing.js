import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

export const IDENTITY_L3_MIN_DURATION_SECONDS = 30;
export const IDENTITY_L3_MAX_DURATION_SECONDS = 60;
export const IDENTITY_L3_MAX_MEDIA_BYTES = 100 * 1024 * 1024;

export class IdentityL3MediaProcessingError extends Error {
  constructor(code) {
    super(code);
    this.name = 'IdentityL3MediaProcessingError';
    this.code = code;
  }
}

function runFfprobe(filePath, {
  executable = process.env.IDENTITY_L3_FFPROBE_PATH || 'ffprobe',
  timeoutMs = 15_000
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [
      '-v', 'error',
      '-show_entries', 'format=format_name,duration:stream=codec_type,codec_name',
      '-of', 'json',
      filePath
    ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let stdout = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new IdentityL3MediaProcessingError('l3_media_probe_timeout'));
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 256 * 1024) {
        child.kill('SIGKILL');
        finish(new IdentityL3MediaProcessingError('l3_media_probe_output_too_large'));
      }
    });
    child.once('error', error => {
      if (error?.code === 'ENOENT') finish(new IdentityL3MediaProcessingError('l3_media_probe_unavailable'));
      else finish(new IdentityL3MediaProcessingError('l3_media_probe_failed'));
    });
    child.once('close', code => {
      if (code !== 0) return finish(new IdentityL3MediaProcessingError('l3_media_probe_invalid'));
      try { finish(null, JSON.parse(stdout)); }
      catch { finish(new IdentityL3MediaProcessingError('l3_media_probe_invalid')); }
    });
  });
}

function validateProbe(probe, declaredMimeType) {
  const formatNames = String(probe?.format?.format_name || '').split(',');
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const video = streams.filter(stream => stream?.codec_type === 'video');
  const audio = streams.filter(stream => stream?.codec_type === 'audio');
  const unsupported = streams.some(stream => !['video', 'audio'].includes(stream?.codec_type));
  const duration = Number(probe?.format?.duration);

  if (video.length !== 1 || audio.length > 1 || unsupported ||
      !Number.isFinite(duration) ||
      duration < IDENTITY_L3_MIN_DURATION_SECONDS ||
      duration > IDENTITY_L3_MAX_DURATION_SECONDS) {
    throw new IdentityL3MediaProcessingError('l3_media_format_or_duration_invalid');
  }

  const codec = String(video[0].codec_name || '').toLowerCase();
  if (declaredMimeType === 'video/mp4') {
    if (!formatNames.some(name => ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'].includes(name)) ||
        !['h264'].includes(codec)) {
      throw new IdentityL3MediaProcessingError('l3_media_format_or_codec_invalid');
    }
  } else if (declaredMimeType === 'video/webm') {
    if (!formatNames.some(name => ['matroska', 'webm'].includes(name)) ||
        !['vp8', 'vp9'].includes(codec)) {
      throw new IdentityL3MediaProcessingError('l3_media_format_or_codec_invalid');
    }
  } else {
    throw new IdentityL3MediaProcessingError('l3_media_mime_type_invalid');
  }

  if (audio.length && !['aac', 'opus', 'vorbis'].includes(String(audio[0].codec_name || '').toLowerCase())) {
    throw new IdentityL3MediaProcessingError('l3_media_audio_codec_invalid');
  }
  return Math.round(duration);
}

function writeSocket(socket, buffer) {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) return reject(new IdentityL3MediaProcessingError('l3_media_scanner_unavailable'));
    if (socket.write(buffer)) resolve();
    else {
      socket.once('drain', resolve);
      socket.once('error', () => reject(new IdentityL3MediaProcessingError('l3_media_scanner_unavailable')));
    }
  });
}

export async function scanIdentityL3FileWithClamD(filePath, {
  host = process.env.IDENTITY_L3_CLAMD_HOST || 'clamav',
  port = Number(process.env.IDENTITY_L3_CLAMD_PORT || 3310),
  timeoutMs = 30_000
} = {}) {
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new IdentityL3MediaProcessingError('l3_media_scanner_not_configured');
  }
  const socket = net.createConnection({ host, port });
  socket.setTimeout(timeoutMs);
  let response = Buffer.alloc(0);
  let responseResolve;
  let responseReject;
  let responseSettled = false;
  const responsePromise = new Promise((resolve, reject) => {
    responseResolve = value => {
      if (responseSettled) return;
      responseSettled = true;
      resolve(value);
    };
    responseReject = error => {
      if (responseSettled) return;
      responseSettled = true;
      reject(error);
    };
  });
  socket.on('data', chunk => {
    response = Buffer.concat([response, chunk]);
    if (response.length > 4096) {
      responseReject(new IdentityL3MediaProcessingError('l3_media_scanner_rejected'));
      socket.destroy();
      return;
    }
    const terminator = response.indexOf(0);
    if (terminator !== -1) responseResolve(response.subarray(0, terminator).toString('utf8'));
  });
  socket.once('error', () => responseReject(new IdentityL3MediaProcessingError('l3_media_scanner_unavailable')));
  socket.once('timeout', () => {
    responseReject(new IdentityL3MediaProcessingError('l3_media_scanner_timeout'));
    socket.destroy();
  });
  socket.once('close', () => {
    if (!responseSettled) responseReject(new IdentityL3MediaProcessingError('l3_media_scanner_rejected'));
  });

  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', () => reject(new IdentityL3MediaProcessingError('l3_media_scanner_unavailable')));
    });
    await writeSocket(socket, Buffer.from('zINSTREAM\\0', 'binary'));
    for await (const chunk of createReadStream(filePath, { highWaterMark: 64 * 1024 })) {
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(chunk.length, 0);
      await writeSocket(socket, header);
      await writeSocket(socket, chunk);
    }
    await writeSocket(socket, Buffer.alloc(4));
    const result = await responsePromise;
    if (/FOUND\\s*$/i.test(result)) {
      throw new IdentityL3MediaProcessingError('l3_media_malware_detected');
    }
    if (!/OK\\s*$/i.test(result)) {
      throw new IdentityL3MediaProcessingError('l3_media_scanner_rejected');
    }
    return { clean: true };
  } catch (error) {
    if (error instanceof IdentityL3MediaProcessingError) throw error;
    throw new IdentityL3MediaProcessingError('l3_media_scanner_unavailable');
  } finally {
    socket.destroy();
  }
}

/**
 * Authenticates/decrypts the encrypted object into a private temporary file,
 * validates the actual media container/codecs/duration, then scans every byte
 * with ClamAV. The caller may move a submission to pending_review only after
 * this function resolves successfully.
 */
export async function processIdentityL3Media({
  objectKey,
  storageRoot,
  encryptionKey,
  declaredMimeType,
  openDecryptedStream,
  scanner = scanIdentityL3FileWithClamD,
  probe = runFfprobe,
  tempRoot = os.tmpdir()
}) {
  if (typeof openDecryptedStream !== 'function') {
    throw new IdentityL3MediaProcessingError('l3_media_processor_not_configured');
  }
  const directory = await mkdtemp(path.join(tempRoot, 'vow-l3-check-'));
  const filePath = path.join(directory, 'media.bin');
  let fileHandle;
  try {
    const source = await openDecryptedStream({ objectKey, root: storageRoot, key: encryptionKey });
    fileHandle = await open(filePath, 'wx', 0o600);
    const output = createWriteStream(filePath, { fd: fileHandle.fd, autoClose: false });
    let totalBytes = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        totalBytes += chunk.length;
        if (totalBytes > IDENTITY_L3_MAX_MEDIA_BYTES) {
          callback(new IdentityL3MediaProcessingError('l3_media_too_large'));
          return;
        }
        callback(null, chunk);
      }
    });
    await pipeline(source, meter, output);
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = null;
    if (totalBytes < 1) throw new IdentityL3MediaProcessingError('l3_media_empty');
    const metadata = await probe(filePath);
    const durationSeconds = validateProbe(metadata, declaredMimeType);
    await scanner(filePath);
    return { durationSeconds, sizeBytes: totalBytes };
  } catch (error) {
    if (error instanceof IdentityL3MediaProcessingError) throw error;
    throw new IdentityL3MediaProcessingError('l3_media_processing_failed');
  } finally {
    if (fileHandle) await fileHandle.close().catch(() => {});
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

export { validateProbe as validateIdentityL3Probe };
