import { Capacitor } from '@capacitor/core';
import { Filesystem } from '@capacitor/filesystem';

type RecordingFileDependencies = {
  convertFileSrc?: (uri: string) => string;
  fetchFile?: (url: string) => Promise<Response>;
  deleteFile?: (uri: string) => Promise<void>;
};

export async function deleteNativeRecordingFile(
  uri: string,
  deleteFile: (uri: string) => Promise<void> = path => Filesystem.deleteFile({ path })
): Promise<void> {
  if (typeof uri !== 'string' || !/^(file|content):\/\//i.test(uri)) {
    throw new TypeError('invalid_native_recording_uri');
  }
  try {
    await deleteFile(uri);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
    if (code !== 'OS-PLUG-FILE-0008') throw new Error('recording_file_cleanup_failed', { cause: error });
  }
}

export async function readAndDeleteNativeRecordingFile(
  uri: string,
  dependencies: RecordingFileDependencies = {}
): Promise<Blob> {
  if (typeof uri !== 'string' || !/^(file|content):\/\//i.test(uri)) {
    throw new TypeError('invalid_native_recording_uri');
  }

  const convertFileSrc = dependencies.convertFileSrc ?? Capacitor.convertFileSrc;
  const fetchFile = dependencies.fetchFile ?? fetch;
  const deleteFile = dependencies.deleteFile ?? (path => Filesystem.deleteFile({ path }));

  let blob: Blob | null = null;
  let readError: unknown = null;
  try {
    const response = await fetchFile(convertFileSrc(uri));
    if (!response.ok) throw new Error('recording_file_unavailable');
    blob = await response.blob();
  } catch (error) {
    readError = error;
  }

  let cleanupError: unknown = null;
  try {
    await deleteNativeRecordingFile(uri, deleteFile);
  } catch (error) {
    cleanupError = error;
  }

  if (readError && cleanupError) {
    throw new Error('recording_read_and_cleanup_failed', { cause: cleanupError });
  }
  if (cleanupError) throw new Error('recording_file_cleanup_failed', { cause: cleanupError });
  if (readError) throw readError;
  if (!(blob instanceof Blob)) throw new Error('recording_file_unavailable');
  return blob;
}
