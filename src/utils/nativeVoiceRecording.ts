type RecordingPermission = { recordAudio: string };

type StartNativeVoiceRecordingDependencies = {
  checkPermissions: () => Promise<RecordingPermission>;
  requestPermissions: () => Promise<RecordingPermission>;
  startRecording: () => Promise<unknown>;
  cancelRecording: () => Promise<unknown>;
  isMounted: () => boolean;
  isActive: () => boolean;
};

export type NativeVoiceRecordingStartResult = 'started' | 'permission-denied' | 'cancelled';

export const VOICE_INTRO_MIN_DURATION_MS = 15_000;
export const VOICE_INTRO_MAX_DURATION_MS = 25_000;
const VOICE_INTRO_MAX_FILE_BYTES = 2 * 1024 * 1024;
const VOICE_INTRO_ALLOWED_MIME_TYPES = new Set(['audio/mp4', 'audio/aac', 'audio/x-m4a']);

export type VoiceIntroRecordingValidation =
  | { ok: true; mimeType: string }
  | { ok: false; reason: 'duration' | 'file' };

export function validateVoiceIntroRecording(blob: Blob, durationMs: number): VoiceIntroRecordingValidation {
  if (!Number.isFinite(durationMs) ||
      durationMs < VOICE_INTRO_MIN_DURATION_MS ||
      durationMs > VOICE_INTRO_MAX_DURATION_MS) {
    return { ok: false, reason: 'duration' };
  }
  if (!(blob instanceof Blob) || blob.size < 64 || blob.size > VOICE_INTRO_MAX_FILE_BYTES) {
    return { ok: false, reason: 'file' };
  }
  const candidateMimeType = blob.type.split(';', 1)[0].trim().toLowerCase();
  return {
    ok: true,
    mimeType: VOICE_INTRO_ALLOWED_MIME_TYPES.has(candidateMimeType) ? candidateMimeType : 'audio/mp4'
  };
}

export async function startNativeVoiceRecording({
  checkPermissions,
  requestPermissions,
  startRecording,
  cancelRecording,
  isMounted,
  isActive
}: StartNativeVoiceRecordingDependencies): Promise<NativeVoiceRecordingStartResult> {
  const canContinue = () => isMounted() && isActive();

  let permission = await checkPermissions();
  if (!canContinue()) return 'cancelled';

  if (permission.recordAudio !== 'granted') {
    permission = await requestPermissions();
    if (!canContinue()) return 'cancelled';
  }

  if (permission.recordAudio !== 'granted') return 'permission-denied';

  await startRecording();
  if (!canContinue()) {
    try { await cancelRecording(); } catch {}
    return 'cancelled';
  }

  return 'started';
}


type AppStateListenerHandle = { remove: () => Promise<void> };

/** Safely disposes an asynchronous native app-state listener, including late registration. */
export function subscribeToNativeAppState(
  register: (listener: (state: { isActive: boolean }) => void) => Promise<AppStateListenerHandle>,
  onStateChange: (state: { isActive: boolean }) => void
): () => void {
  let disposed = false;
  let handle: AppStateListenerHandle | null = null;
  void register(onStateChange).then(registered => {
    if (disposed) {
      void registered.remove().catch(() => {});
      return;
    }
    handle = registered;
  }).catch(() => {});
  return () => {
    disposed = true;
    if (handle) {
      const current = handle;
      handle = null;
      void current.remove().catch(() => {});
    }
  };
}
