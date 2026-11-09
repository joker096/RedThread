import { PushNotifications } from '@capacitor/push-notifications';
import type { PluginListenerHandle } from '@capacitor/core';
import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { useLocale } from '../i18n/LocaleProvider';
import { isNativeVowApp } from '../utils/apiClient';

type PushStatus = { available: boolean; registered: boolean; platform: 'android' | 'ios' | null };

export const MobilePushSettingsPanel: FC = () => {
  const { t, locale } = useLocale();
  const [status, setStatus] = useState<PushStatus>({ available: false, registered: false, platform: null });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const listeners = useRef<PluginListenerHandle[]>([]);
  const mounted = useRef(true);

  const refreshStatus = useCallback(async () => {
    if (!isNativeVowApp()) return;
    const response = await fetch('/api/mobile/push/status', { credentials: 'include' });
    if (!response.ok) throw new Error('push_status_failed');
    const next = await response.json() as PushStatus;
    if (mounted.current) setStatus({
      available: next.available === true,
      registered: next.registered === true,
      platform: next.platform === 'android' || next.platform === 'ios' ? next.platform : null
    });
    return next;
  }, []);

  const saveToken = useCallback(async (token: string) => {
    const response = await fetch('/api/mobile/push-token', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, locale })
    });
    if (!response.ok) throw new Error('push_registration_failed');
    if (mounted.current) {
      setStatus(current => ({ ...current, registered: true }));
      setNotice(t('pushEnabled'));
    }
  }, [locale, t]);

  useEffect(() => {
    mounted.current = true;
    if (!isNativeVowApp()) return () => { mounted.current = false; };
    let disposed = false;
    const add = async () => {
      const handles = await Promise.all([
        PushNotifications.addListener('registration', event => {
          void saveToken(event.value).catch(() => {
            if (mounted.current) setNotice(t('pushRegistrationError'));
          });
        }),
        PushNotifications.addListener('registrationError', () => {
          if (mounted.current) setNotice(t('pushRegistrationError'));
        }),
        PushNotifications.addListener('pushNotificationReceived', () => {
          window.dispatchEvent(new Event('vow:notifications-changed'));
        }),
        PushNotifications.addListener('pushNotificationActionPerformed', action => {
          const route = action.notification.data?.route;
          if (route === '/gifts') window.dispatchEvent(new Event('vow:open-gifts'));
          else if (route === '/chats') window.dispatchEvent(new Event('vow:match-created'));
        })
      ]);
      if (disposed) {
        await Promise.all(handles.map(handle => handle.remove()));
      } else {
        listeners.current = handles;
      }
    };
    void add().catch(() => {
      if (mounted.current) setNotice(t('pushRegistrationError'));
    });
    const check = async () => {
      try {
        const next = await refreshStatus();
        if (!next?.available) return;
        const permission = await PushNotifications.checkPermissions();
        if (permission.receive === 'granted' && next.registered) {
          await PushNotifications.register();
        } else if (permission.receive === 'denied' && next.registered) {
          await fetch('/api/mobile/push-token', { method: 'DELETE', credentials: 'include' });
          if (mounted.current) setStatus(current => ({ ...current, registered: false }));
        }
      } catch {
        if (mounted.current) setNotice(t('pushStatusUnavailable'));
      }
    };
    void check();
    window.addEventListener('vow:app-resumed', check);
    return () => {
      disposed = true;
      mounted.current = false;
      window.removeEventListener('vow:app-resumed', check);
      void Promise.all(listeners.current.map(handle => handle.remove()));
      listeners.current = [];
    };
  }, [refreshStatus, saveToken, t]);

  const enable = async () => {
    if (!status.available || busy) return;
    setBusy(true);
    setNotice('');
    try {
      let permission = await PushNotifications.checkPermissions();
      if (permission.receive !== 'granted') permission = await PushNotifications.requestPermissions();
      if (permission.receive !== 'granted') {
        setNotice(t('pushPermissionDenied'));
        return;
      }
      setNotice(t('pushRegistrationPending'));
      await PushNotifications.register();
    } catch {
      setNotice(t('pushRegistrationError'));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (busy) return;
    setBusy(true);
    setNotice('');
    try {
      const response = await fetch('/api/mobile/push-token', { method: 'DELETE', credentials: 'include' });
      if (!response.ok) throw new Error('push_revocation_failed');
      setStatus(current => ({ ...current, registered: false }));
      await PushNotifications.unregister().catch(() => undefined);
      setNotice(t('pushDisabled'));
    } catch {
      setNotice(t('pushStatusUnavailable'));
    } finally {
      setBusy(false);
    }
  };

  if (!isNativeVowApp()) return null;
  return (
    <section className="mb-3 rounded-xl border border-white/10 bg-stone-950/60 p-3" aria-label={t('pushSettings')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-stone-100">{t('pushSettings')}</p>
          <p className="mt-1 text-[11px] text-stone-400">
            {!status.available ? t('pushNotConfigured') : status.registered ? t('pushEnabled') : t('pushDisabled')}
          </p>
        </div>
        {status.available && (status.registered
          ? <button type="button" onClick={() => void disable()} disabled={busy} className="min-h-11 rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-stone-200 disabled:opacity-50">{t('pushTurnOff')}</button>
          : <button type="button" onClick={() => void enable()} disabled={busy} className="min-h-11 rounded-lg bg-rose-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{t('pushTurnOn')}</button>)}
      </div>
      {notice && <p role="status" className="mt-2 text-[11px] text-rose-200">{notice}</p>}
    </section>
  );
};
