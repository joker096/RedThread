import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '../i18n/LocaleProvider.tsx';

type Preferences = { requestsEnabled: boolean };
const defaults: Preferences = { requestsEnabled: false };

export function normalizeGiftReceivingPayload(value: unknown): Preferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...defaults };
  const candidate = value as Partial<Preferences>;
  return typeof candidate.requestsEnabled === 'boolean'
    ? { requestsEnabled: candidate.requestsEnabled }
    : { ...defaults };
}

export const GiftReceivingPreferencesPanel: React.FC = () => {
  const { t } = useLocale();
  const [preferences, setPreferences] = useState<Preferences>(defaults);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [notice, setNotice] = useState('');
  const requestEpoch = useRef(0);
  // Keep the last server-confirmed value so a failed save cannot leave the
  // checkbox showing an opt-in that the server never persisted.
  const confirmedPreferences = useRef<Preferences>({ ...defaults });

  const load = useCallback(async () => {
    const epoch = ++requestEpoch.current;
    setLoading(true);
    try {
      const response = await fetch('/api/gifts/preferences', { credentials: 'include' });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !payload || typeof payload !== 'object' || !('preferences' in payload)) {
        throw new Error(response.status === 401 ? t('giftPreferencesSignInRequired') : t('giftPreferencesLoadError'));
      }
      if (epoch !== requestEpoch.current) return;
      const loaded = normalizeGiftReceivingPayload((payload as { preferences: unknown }).preferences);
      confirmedPreferences.current = loaded;
      setPreferences(loaded);
      setNotice('');
      setLoadFailed(false);
    } catch (error) {
      if (epoch === requestEpoch.current) {
        setLoadFailed(true);
        setNotice(error instanceof Error ? error.message : t('giftPreferencesLoadError'));
      }
    } finally {
      if (epoch === requestEpoch.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
    const refreshOnSession = () => {
      // Preferences belong to the authenticated recipient, not this mounted panel.
      requestEpoch.current += 1;
      confirmedPreferences.current = { ...defaults };
      setPreferences({ ...defaults });
      setSaving(false);
      setLoadFailed(false);
      setNotice('');
      void load();
    };
    window.addEventListener('vow:session-changed', refreshOnSession);
    return () => {
      window.removeEventListener('vow:session-changed', refreshOnSession);
      requestEpoch.current += 1;
    };
  }, [load]);

  const save = async (next: Preferences) => {
    const epoch = ++requestEpoch.current;
    setSaving(true);
    setNotice('');
    try {
      const response = await fetch('/api/gifts/preferences', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next)
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !payload || typeof payload !== 'object' || !('preferences' in payload)) {
        throw new Error(response.status === 401 ? t('giftPreferencesSignInRequired') : t('giftPreferencesSaveError'));
      }
      if (epoch !== requestEpoch.current) return;
      const saved = normalizeGiftReceivingPayload((payload as { preferences: unknown }).preferences);
      confirmedPreferences.current = saved;
      setPreferences(saved);
      setNotice(t('giftPreferencesSaved'));
      setLoadFailed(false);
    } catch (error) {
      if (epoch === requestEpoch.current) {
        setPreferences({ ...confirmedPreferences.current });
        setNotice(error instanceof Error ? error.message : t('giftPreferencesSaveError'));
      }
    } finally {
      if (epoch === requestEpoch.current) setSaving(false);
    }
  };

  return (
    <section className="mx-auto mt-4 w-full max-w-md rounded-2xl border border-white/10 bg-stone-900 p-4 text-left text-white" aria-labelledby="gift-preferences-title">
      <h2 id="gift-preferences-title" className="text-lg font-semibold">{t('giftPreferencesTitle')}</h2>
      <p className="mt-1 text-sm text-stone-300">{t('giftPreferencesIntro')}</p>
      <p className="mt-2 text-xs text-stone-400">{t('giftPreferencesPrivacy')}</p>
      {loading ? <p className="mt-3 text-sm text-stone-300" role="status">{t('giftPreferencesLoading')}</p> : (
        <form className="mt-4 space-y-3" onSubmit={event => { event.preventDefault(); void save(preferences); }}>
          <label className="flex items-start gap-3 rounded-xl border border-white/10 p-3">
            <input
              type="checkbox"
              className="mt-1 h-5 w-5 accent-rose-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"
              checked={preferences.requestsEnabled}
              disabled={saving || loadFailed}
              onChange={event => setPreferences({ requestsEnabled: event.target.checked })}
            />
            <span>
              <span className="block text-sm font-medium">{t('giftPreferencesEnable')}</span>
              <span className="mt-1 block text-xs text-stone-400">{t('giftPreferencesEnableDescription')}</span>
            </span>
          </label>
          <button type="submit" disabled={saving || loadFailed} className="w-full rounded-xl bg-rose-700 px-4 py-2.5 text-sm font-semibold hover:bg-rose-600 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300">
            {saving ? t('giftPreferencesSaving') : t('giftPreferencesSave')}
          </button>
        </form>
      )}
      {loadFailed && !loading && <button type="button" onClick={() => void load()} className="mt-3 rounded-lg border border-white/20 px-3 py-2 text-sm hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300">{t('giftPreferencesRetry')}</button>}
      {notice && <p className="mt-3 text-sm text-stone-200" role="status" aria-live="polite">{notice}</p>}
    </section>
  );
};
