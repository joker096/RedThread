import test from 'node:test';
import assert from 'node:assert/strict';
import { startNativeVoiceRecording } from './nativeVoiceRecording.ts';

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
