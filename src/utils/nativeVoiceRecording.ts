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
