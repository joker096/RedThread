import test from 'node:test';
import assert from 'node:assert/strict';
import { startNativeVoiceRecording, validateVoiceIntroRecording } from './nativeVoiceRecording.ts';

const granted = { recordAudio: 'granted' };
const denied = { recordAudio: 'denied' };

test('does not request or start recording when the screen unmounts during permission check', async () => {
  let starts = 0;
  let requests = 0;
  const result = await startNativeVoiceRecording({
    checkPermissions: async () => granted,
    requestPermissions: async () => { requests += 1; return granted; },
    startRecording: async () => { starts += 1; },
    cancelRecording: async () => {},
    isMounted: () => false,
    isActive: () => true
  });
  assert.equal(result, 'cancelled');
  assert.equal(requests, 0);
  assert.equal(starts, 0);
});

test('does not start recording when the app moves to the background during permission prompt', async () => {
  let active = true;
  let starts = 0;
  const result = await startNativeVoiceRecording({
    checkPermissions: async () => ({ recordAudio: 'prompt' }),
    requestPermissions: async () => { active = false; return granted; },
    startRecording: async () => { starts += 1; },
    cancelRecording: async () => {},
    isMounted: () => true,
    isActive: () => active
  });
  assert.equal(result, 'cancelled');
  assert.equal(starts, 0);
});

test('cancels native recording if the screen unmounts while native start is pending', async () => {
  let mounted = true;
  let cancelled = 0;
  let finishStart: (() => void) | undefined;
  const resultPromise = startNativeVoiceRecording({
    checkPermissions: async () => granted,
    requestPermissions: async () => granted,
    startRecording: () => new Promise<void>(resolve => { finishStart = resolve; }),
    cancelRecording: async () => { cancelled += 1; },
    isMounted: () => mounted,
    isActive: () => true
  });
  await Promise.resolve();
  mounted = false;
  finishStart?.();
  assert.equal(await resultPromise, 'cancelled');
  assert.equal(cancelled, 1);
});

test('returns permission denied without starting the recorder', async () => {
  let starts = 0;
  const result = await startNativeVoiceRecording({
    checkPermissions: async () => denied,
    requestPermissions: async () => denied,
    startRecording: async () => { starts += 1; },
    cancelRecording: async () => {},
    isMounted: () => true,
    isActive: () => true
  });
  assert.equal(result, 'permission-denied');
  assert.equal(starts, 0);
});

test('starts recording only after permission is granted and app remains active', async () => {
  let starts = 0;
  const result = await startNativeVoiceRecording({
    checkPermissions: async () => ({ recordAudio: 'prompt' }),
    requestPermissions: async () => granted,
    startRecording: async () => { starts += 1; },
    cancelRecording: async () => {},
    isMounted: () => true,
    isActive: () => true
  });
  assert.equal(result, 'started');
  assert.equal(starts, 1);
});


test('validates synthetic audio fixtures at inclusive 15- and 25-second boundaries', () => {
  const fixture = new Blob([new Uint8Array(64)], { type: 'audio/mp4' });
  assert.deepEqual(validateVoiceIntroRecording(fixture, 15_000), { ok: true, mimeType: 'audio/mp4' });
  assert.deepEqual(validateVoiceIntroRecording(fixture, 25_000), { ok: true, mimeType: 'audio/mp4' });
});

test('rejects synthetic audio fixtures outside the allowed duration and size bounds', () => {
  const valid = new Blob([new Uint8Array(64)], { type: 'audio/mp4' });
  const tooSmall = new Blob([new Uint8Array(63)], { type: 'audio/mp4' });
  const tooLarge = new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: 'audio/mp4' });
  assert.deepEqual(validateVoiceIntroRecording(valid, 14_999), { ok: false, reason: 'duration' });
  assert.deepEqual(validateVoiceIntroRecording(valid, 25_001), { ok: false, reason: 'duration' });
  assert.deepEqual(validateVoiceIntroRecording(valid, Number.NaN), { ok: false, reason: 'duration' });
  assert.deepEqual(validateVoiceIntroRecording(tooSmall, 20_000), { ok: false, reason: 'file' });
  assert.deepEqual(validateVoiceIntroRecording(tooLarge, 20_000), { ok: false, reason: 'file' });
});

test('normalizes unsupported audio MIME types to the existing upload fallback', () => {
  const fixture = new Blob([new Uint8Array(64)], { type: 'audio/wav' });
  assert.deepEqual(validateVoiceIntroRecording(fixture, 20_000), { ok: true, mimeType: 'audio/mp4' });
});
