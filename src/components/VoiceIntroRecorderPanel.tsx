import React, { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { CapacitorAudioRecorder } from '@capgo/capacitor-audio-recorder';
import { deleteNativeRecordingFile, readAndDeleteNativeRecordingFile } from '../utils/nativeRecordingFile.ts';
import { useLocale } from '../i18n/LocaleProvider.tsx';

type VoiceIntro = { id: string; status: 'pending' | 'approved' | 'rejected'; durationMs: number };
type Props = { voiceIntro: VoiceIntro | null; onChanged: (voiceIntro: VoiceIntro | null) => void };
type Preview = { blob: Blob; url: string; mimeType: string; durationMs: number };

const MIN_DURATION_MS = 15_000;
const MAX_DURATION_MS = 25_000;
const ALLOWED_MIME_TYPES = new Set(['audio/mp4', 'audio/aac', 'audio/x-m4a']);

export const VoiceIntroRecorderPanel: React.FC<Props> = ({ voiceIntro, onChanged }) => {
  const { t } = useLocale();
  const [saved, setSaved] = useState<VoiceIntro | null>(voiceIntro);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [savedAudioUrl, setSavedAudioUrl] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const recordingRef = useRef(false);
  const startedAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => { setSaved(voiceIntro); setSavedAudioUrl(null); }, [voiceIntro]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!savedAudioUrl) return;
    return () => URL.revokeObjectURL(savedAudioUrl);
  }, [savedAudioUrl]);

  useEffect(() => {
    if (!preview?.url) return;
    return () => URL.revokeObjectURL(preview.url);
  }, [preview?.url]);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const cancelRecording = async () => {
    clearTimer();
    if (!recordingRef.current) return;
    recordingRef.current = false;
    if (mountedRef.current) setRecording(false);
    try { await CapacitorAudioRecorder.cancelRecording(); } catch {}
  };

  const stopRecording = async () => {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    clearTimer();
    if (mountedRef.current) { setRecording(false); setBusy(true); }
    try {
      const result = await CapacitorAudioRecorder.stopRecording();
      if (!mountedRef.current) {
        if (result.uri) await deleteNativeRecordingFile(result.uri);
        return;
      }
      const durationMs = Number.isFinite(result.duration) && Number(result.duration) > 0
        ? Math.round(Number(result.duration))
        : Math.round(Date.now() - startedAtRef.current);
      if (durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) {
        if (result.uri) await deleteNativeRecordingFile(result.uri);
        if (mountedRef.current) setNotice(t('voiceIntroDurationError'));
        return;
      }

      let blob = result.blob;
      if (result.uri) {
        if (!blob) blob = await readAndDeleteNativeRecordingFile(result.uri);
        else await deleteNativeRecordingFile(result.uri);
      }
      if (!(blob instanceof Blob) || blob.size < 64 || blob.size > 2 * 1024 * 1024) {
        throw new Error('invalid_recording_file');
      }
      const candidateMimeType = blob.type.split(';', 1)[0].trim().toLowerCase();
      const mimeType = ALLOWED_MIME_TYPES.has(candidateMimeType) ? candidateMimeType : 'audio/mp4';
      const url = URL.createObjectURL(blob);
      if (!mountedRef.current) {
        URL.revokeObjectURL(url);
        return;
      }
      setPreview({ blob, url, mimeType, durationMs });
      setNotice('');
    } catch {
      if (mountedRef.current) setNotice(t('voiceIntroUploadError'));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const startRecording = async () => {
    if (recordingRef.current || busy) return;
    setNotice('');
    setPreview(current => {
      if (current?.url) URL.revokeObjectURL(current.url);
      return null;
    });
    try {
      let permission = await CapacitorAudioRecorder.checkPermissions();
      if (!mountedRef.current) return;
      if (permission.recordAudio !== 'granted') {
        permission = await CapacitorAudioRecorder.requestPermissions();
        if (!mountedRef.current) return;
      }
      if (permission.recordAudio !== 'granted') {
        if (mountedRef.current) setNotice(t('voiceIntroPermissionDenied'));
        return;
      }
      await CapacitorAudioRecorder.startRecording({ bitRate: 64_000, sampleRate: 44_100, resetToPlaybackOnStop: true });
      if (!mountedRef.current) {
        try { await CapacitorAudioRecorder.cancelRecording(); } catch {}
        return;
      }
      recordingRef.current = true;
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      setRecording(true);
      timerRef.current = window.setInterval(() => {
        if (!mountedRef.current) return;
        const elapsed = Date.now() - startedAtRef.current;
        setElapsedMs(elapsed);
        if (elapsed >= MAX_DURATION_MS) void stopRecording();
      }, 250);
    } catch {
      if (mountedRef.current) setNotice(t('voiceIntroPermissionDenied'));
    }
  };

  useEffect(() => {
    let listener: { remove: () => Promise<void> } | undefined;
    void App.addListener('appStateChange', state => {
      if (!state.isActive && recordingRef.current) void cancelRecording();
    }).then(value => { listener = value; }).catch(() => {});
    return () => {
      void listener?.remove();
      clearTimer();
      if (recordingRef.current) {
        recordingRef.current = false;
        void CapacitorAudioRecorder.cancelRecording().catch(() => {});
      }
    };
  }, []);

  const upload = async () => {
    if (!preview || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const response = await fetch('/api/profiles/me/voice-intro', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': preview.mimeType },
        body: preview.blob
      });
      const data = await response.json().catch(() => null);
      if (!mountedRef.current) return;
      if (response.status === 401) throw new Error(t('profileLoginPrompt'));
      if (response.status === 503) throw new Error(t('voiceIntroStorageError'));
      if (!response.ok || !data?.voiceIntro || typeof data.voiceIntro.id !== 'string') {
        throw new Error(t('voiceIntroUploadError'));
      }
      const next: VoiceIntro = {
        id: data.voiceIntro.id,
        status: 'pending',
        durationMs: Number(data.voiceIntro.durationMs) || preview.durationMs
      };
      setSavedAudioUrl(null);
      setSaved(next);
      onChanged(next);
      setPreview(null);
      setNotice(t('voiceIntroPending'));
    } catch (error) {
      if (mountedRef.current) setNotice(error instanceof Error ? error.message : t('voiceIntroUploadError'));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const loadSavedAudio = async () => {
    if (!saved || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const response = await fetch('/api/profiles/me/voice-intro', { credentials: 'include' });
      if (!mountedRef.current) return;
      if (response.status === 401) throw new Error(t('profileLoginPrompt'));
      if (!response.ok) throw new Error(t('voiceIntroPlaybackError'));
      const blob = await response.blob();
      if (blob.size < 64 || blob.size > 2 * 1024 * 1024) throw new Error(t('voiceIntroPlaybackError'));
      const url = URL.createObjectURL(blob);
      if (!mountedRef.current) {
        URL.revokeObjectURL(url);
        return;
      }
      setSavedAudioUrl(url);
    } catch (error) {
      if (mountedRef.current) setNotice(error instanceof Error ? error.message : t('voiceIntroPlaybackError'));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const removeSaved = async () => {
    if (!saved || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const response = await fetch('/api/profiles/me/voice-intro', {
        method: 'DELETE',
        credentials: 'include'
      });
      if (!mountedRef.current) return;
      if (response.status === 401) throw new Error(t('profileLoginPrompt'));
      if (!response.ok && response.status !== 404) throw new Error(t('voiceIntroUploadError'));
      setSavedAudioUrl(null);
      setSaved(null);
      onChanged(null);
      setNotice('');
    } catch (error) {
      if (mountedRef.current) setNotice(error instanceof Error ? error.message : t('voiceIntroUploadError'));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const statusLabel = saved?.status === 'approved'
    ? t('voiceIntroApproved')
    : saved?.status === 'rejected'
      ? t('voiceIntroRejected')
      : saved
        ? t('voiceIntroPending')
        : '';

  return (
    <section data-testid="voice-intro-recorder" className="rounded-2xl border border-rose-400/20 bg-stone-950/60 p-3">
      <h4 className="text-sm font-semibold text-white">{t('voiceIntroTitle')}</h4>
      <p className="mt-1 text-[11px] leading-relaxed text-stone-400">{t('voiceIntroDescription')}</p>
      {saved && (
        <div className="mt-3 rounded-xl border border-white/10 p-3">
          <p role="status" className="text-xs text-stone-300">{statusLabel}</p>
          {savedAudioUrl
            ? <audio className="mt-2 w-full" controls preload="none" src={savedAudioUrl} />
            : <button type="button" onClick={() => void loadSavedAudio()} disabled={busy} className="mt-2 min-h-11 rounded-lg border border-white/10 px-3 py-2 text-xs text-stone-300 disabled:opacity-50">{t('voiceIntroListen')}</button>}
          <button type="button" onClick={() => void removeSaved()} disabled={busy || recording} className="mt-2 min-h-11 rounded-lg border border-white/10 px-3 py-2 text-xs text-stone-300 disabled:opacity-50">{t('voiceIntroDelete')}</button>
        </div>
      )}
      {recording && (
        <div className="mt-3 rounded-xl border border-rose-400/20 bg-rose-950/20 p-3">
          <p className="text-xs font-semibold text-rose-100">{t('voiceIntroRecording')}</p>
          <p className="mt-1 font-mono text-sm tabular-nums text-white">{(elapsedMs / 1000).toFixed(1)} / 25.0 {t('voiceIntroDurationLabel')}</p>
          <button type="button" onClick={() => void stopRecording()} disabled={elapsedMs < MIN_DURATION_MS || busy} className="mt-2 min-h-11 rounded-lg bg-rose-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-40">{t('voiceIntroStop')}</button>
          <button type="button" onClick={() => void cancelRecording()} disabled={busy} className="ms-2 mt-2 min-h-11 rounded-lg border border-white/10 px-3 py-2 text-xs text-stone-300">{t('voiceIntroCancel')}</button>
        </div>
      )}
      {!recording && preview && (
        <div className="mt-3 rounded-xl border border-white/10 p-3">
          <p className="text-xs text-stone-300">{(preview.durationMs / 1000).toFixed(1)} {t('voiceIntroDurationLabel')}</p>
          <audio className="mt-2 w-full" controls preload="metadata" src={preview.url} />
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={() => void upload()} disabled={busy} className="min-h-11 rounded-lg bg-rose-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{t('voiceIntroSave')}</button>
            <button type="button" onClick={() => { setPreview(null); setNotice(''); }} disabled={busy} className="min-h-11 rounded-lg border border-white/10 px-3 py-2 text-xs text-stone-300">{t('voiceIntroCancel')}</button>
          </div>
        </div>
      )}
      {!recording && !preview && (
        <button type="button" onClick={() => void startRecording()} disabled={busy} className="mt-3 min-h-11 w-full rounded-xl border border-rose-300/30 bg-rose-600/15 px-4 py-3 text-xs font-bold text-rose-100 disabled:opacity-50">{t('voiceIntroRecord')}</button>
      )}
      {notice && <p role="status" aria-live="polite" className="mt-2 text-xs text-amber-200">{notice}</p>}
    </section>
  );
};
