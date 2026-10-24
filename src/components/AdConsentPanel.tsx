import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '../i18n/LocaleProvider.tsx';

type Preferences = {
  adsConsent: boolean;
  dateOffersConsent: boolean;
  weddingOffersConsent: boolean;
  marriagePlanningOptIn: boolean;
  categoryConsents: Record<string, boolean>;
};

const defaults: Preferences = {
  adsConsent: false,
  dateOffersConsent: false,
  weddingOffersConsent: false,
  marriagePlanningOptIn: false,
  categoryConsents: {}
};

const categories = ['fashion', 'beauty', 'travel', 'general_local'] as const;

export function normalizeAdConsentPayload(value: unknown): Preferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...defaults, categoryConsents: {} };
  }

  const candidate = value as Partial<Preferences>;
  if (typeof candidate.adsConsent !== 'boolean' ||
      typeof candidate.dateOffersConsent !== 'boolean' ||
      typeof candidate.weddingOffersConsent !== 'boolean' ||
      typeof candidate.marriagePlanningOptIn !== 'boolean') {
    return { ...defaults, categoryConsents: {} };
  }

  const categoryConsents: Record<string, boolean> = {};
  if (candidate.categoryConsents && typeof candidate.categoryConsents === 'object' &&
      !Array.isArray(candidate.categoryConsents)) {
    for (const category of categories) {
      if (candidate.categoryConsents[category] === true) categoryConsents[category] = true;
    }
  }

  if (candidate.adsConsent !== true) return { ...defaults, categoryConsents: {} };

  const weddingOffersConsent = candidate.weddingOffersConsent === true;
  return {
    adsConsent: true,
    dateOffersConsent: candidate.dateOffersConsent === true,
    weddingOffersConsent,
    marriagePlanningOptIn: weddingOffersConsent && candidate.marriagePlanningOptIn === true,
    categoryConsents
  };
}

export const AdConsentPanel: React.FC = () => {
  const { t } = useLocale();
  const [preferences, setPreferences] = useState<Preferences>(defaults);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const requestEpoch = useRef(0);

  const load = useCallback(async () => {
    const epoch = ++requestEpoch.current;
    setLoading(true);
    try {
      const response = await fetch('/api/ads/consent', { credentials: 'include' });
      if (!response.ok) {
        if (response.status === 401) throw new Error(t('adConsentSignInRequired'));
        throw new Error(t('adConsentLoadError'));
      }
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== 'object' || !('preferences' in payload)) {
        throw new Error(t('adConsentLoadError'));
      }
      const value = (payload as { preferences: unknown }).preferences;
      if (epoch !== requestEpoch.current) return;
      setPreferences(normalizeAdConsentPayload(value));
      setNotice('');
    } catch (error) {
      if (epoch === requestEpoch.current) setNotice(error instanceof Error ? error.message : t('adConsentLoadError'));
    } finally {
      if (epoch === requestEpoch.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
    return () => { requestEpoch.current += 1; };
  }, [load]);

  const update = (key: keyof Omit<Preferences, 'categoryConsents'>, checked: boolean) => {
    setPreferences(current => {
      if (key === 'adsConsent' && !checked) return defaults;
      if (key === 'weddingOffersConsent' && !checked) {
        return { ...current, weddingOffersConsent: false, marriagePlanningOptIn: false };
      }
      return { ...current, [key]: checked };
    });
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const epoch = ++requestEpoch.current;
    setSaving(true);
    setNotice('');
    try {
      const response = await fetch('/api/ads/consent', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(preferences)
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 401) throw new Error(t('adConsentSignInRequired'));
        throw new Error(t('adConsentSaveError'));
      }
      if (epoch !== requestEpoch.current) return;
      setPreferences(normalizeAdConsentPayload(payload?.preferences));
      setNotice(t('adConsentSaved'));
    } catch (error) {
      if (epoch === requestEpoch.current) setNotice(error instanceof Error ? error.message : t('adConsentSaveError'));
    } finally {
      if (epoch === requestEpoch.current) setSaving(false);
    }
  };

  const toggle = (label: string, checked: boolean, onChange: (value: boolean) => void, disabled = false, description?: string) => (
    <label className={`flex min-h-12 items-start gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <input type="checkbox" checked={checked} disabled={disabled || loading || saving} onChange={event => onChange(event.target.checked)}
        className="mt-1 h-4 w-4 accent-rose-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400" />
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-stone-100">{label}</span>
        {description && <span className="mt-1 block text-xs leading-relaxed text-stone-400">{description}</span>}
      </span>
    </label>
  );

  return (
    <section aria-labelledby="ad-consent-heading" className="mx-auto mt-4 w-full max-w-md rounded-3xl border border-white/10 bg-stone-900 p-4 text-left shadow-xl sm:p-5">
      <div className="mb-4">
        <h2 id="ad-consent-heading" className="text-base font-bold text-white">{t('adConsentTitle')}</h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-300">{t('adConsentIntro')}</p>
        <p className="mt-2 text-xs leading-relaxed text-stone-400">{t('adConsentPrivacy')}</p>
      </div>
      {loading ? (
        <div role="status" className="py-4 text-sm text-stone-300">{t('adConsentLoading')}</div>
      ) : (
        <form onSubmit={save} className="space-y-3">
          {toggle(t('adConsentMaster'), preferences.adsConsent, value => update('adsConsent', value), false, t('adConsentMasterDescription'))}
          <fieldset disabled={!preferences.adsConsent} className="space-y-3">
            <legend className="mb-2 text-xs font-bold uppercase tracking-wide text-stone-400">{t('adConsentContextHeading')}</legend>
            {toggle(t('adConsentDateOffers'), preferences.dateOffersConsent, value => update('dateOffersConsent', value), !preferences.adsConsent, t('adConsentDateOffersDescription'))}
            {toggle(t('adConsentWeddingOffers'), preferences.weddingOffersConsent, value => update('weddingOffersConsent', value), !preferences.adsConsent, t('adConsentWeddingOffersDescription'))}
            {toggle(t('adConsentMarriagePlanning'), preferences.marriagePlanningOptIn, value => update('marriagePlanningOptIn', value), !preferences.adsConsent || !preferences.weddingOffersConsent, t('adConsentMarriagePlanningDescription'))}
            <div className="space-y-2 pt-1">
              <p className="text-xs font-bold uppercase tracking-wide text-stone-400">{t('adConsentCategoryHeading')}</p>
              {categories.map(category => toggle(
                t(({ fashion: 'adConsentFashion', beauty: 'adConsentBeauty', travel: 'adConsentTravel', general_local: 'adConsentLocal' } as const)[category]),
                preferences.categoryConsents[category] === true,
                value => setPreferences(current => {
                  const next = { ...current.categoryConsents };
                  if (value) next[category] = true; else delete next[category];
                  return { ...current, categoryConsents: next };
                }),
                !preferences.adsConsent
              ))}
            </div>
          </fieldset>
          <button type="submit" disabled={loading || saving} className="min-h-11 w-full rounded-xl bg-rose-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-900">
            {saving ? t('adConsentSaving') : t('adConsentSave')}
          </button>
        </form>
      )}
      {notice && <p role="status" aria-live="polite" className="mt-3 rounded-xl border border-white/10 bg-black/20 p-3 text-sm text-stone-200">{notice}</p>}
    </section>
  );
};
