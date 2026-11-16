import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteNativeRecordingFile, readAndDeleteNativeRecordingFile } from './nativeRecordingFile.ts';

test('reads a native recording and deletes its original private cache file', async () => {
  const deleted: string[] = [];
  const expected = new Blob(['private audio bytes'], { type: 'audio/mp4' });
  const result = await readAndDeleteNativeRecordingFile('file:///private/voice.m4a', {
    convertFileSrc: uri => 'capacitor://localhost/_capacitor_file_' + encodeURIComponent(uri),
    fetchFile: async () => new Response(expected, { status: 200 }),
    deleteFile: async uri => { deleted.push(uri); }
  });
  assert.equal(await result.text(), 'private audio bytes');
  assert.deepEqual(deleted, ['file:///private/voice.m4a']);
});

test('attempts native cache deletion even when reading the recording fails', async () => {
  const deleted: string[] = [];
  await assert.rejects(
    readAndDeleteNativeRecordingFile('content://media/external/audio/42', {
      convertFileSrc: uri => uri,
      fetchFile: async () => { throw new Error('read failed'); },
      deleteFile: async uri => { deleted.push(uri); }
    }),
    /read failed/
  );
  assert.deepEqual(deleted, ['content://media/external/audio/42']);
});

test('does not silently accept failure to delete a native recording file', async () => {
  await assert.rejects(
    readAndDeleteNativeRecordingFile('file:///private/voice.m4a', {
      convertFileSrc: uri => uri,
      fetchFile: async () => new Response(new Blob(['audio']), { status: 200 }),
      deleteFile: async () => { const error = new Error('permission denied'); (error as Error & { code: string }).code = 'OS-PLUG-FILE-0013'; throw error; }
    }),
    /recording_file_cleanup_failed/
  );
});

test('rejects non-file recording references before accessing the filesystem', async () => {
  await assert.rejects(
    readAndDeleteNativeRecordingFile('https://example.invalid/audio.m4a', {
      deleteFile: async () => { throw new Error('must not run'); }
    }),
    /invalid_native_recording_uri/
  );
});

test('deletes native recordings rejected by duration validation and treats missing files as already cleaned', async () => {
  const deleted: string[] = [];
  await deleteNativeRecordingFile('file:///private/too-short.m4a', async uri => { deleted.push(uri); });
  await deleteNativeRecordingFile('file:///private/already-gone.m4a', async () => {
    const error = new Error('file missing') as Error & { code: string };
    error.code = 'OS-PLUG-FILE-0008';
    throw error;
  });
  assert.deepEqual(deleted, ['file:///private/too-short.m4a']);
});

test('reports failure when a rejected native recording cannot be removed', async () => {
  await assert.rejects(
    deleteNativeRecordingFile('file:///private/too-short.m4a', async () => {
      const error = new Error('permission denied') as Error & { code: string };
      error.code = 'OS-PLUG-FILE-0013';
      throw error;
    }),
    /recording_file_cleanup_failed/
  );
});
