import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '../i18n/LocaleProvider.tsx';
import { formatMinorCurrency } from '../utils/currency.ts';

type GiftMatch = { id: string; displayName: string };
type GiftCatalogItem = {
  id: string;
  category: 'flowers' | 'chocolate' | 'confectionery' | 'book' | 'approved_gift';
  displayName: string;
  itemPriceMinorUnits: number;
  deliveryFeeMinorUnits: number;
  totalMinorUnits: number;
  currency: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isCurrentGiftSessionAction(actionEpoch: number, currentEpoch: number): boolean {
  return Number.isSafeInteger(actionEpoch) && Number.isSafeInteger(currentEpoch) && actionEpoch === currentEpoch;
}

export function normalizeGiftMatches(value: unknown): GiftMatch[] {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('matches' in value)) return [];
  const matches = (value as { matches?: unknown }).matches;
  if (!Array.isArray(matches)) return [];
  const seen = new Set<string>();
  return matches.flatMap((entry): GiftMatch[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const candidate = entry as Partial<GiftMatch>;
    if (typeof candidate.id !== 'string' || !UUID_PATTERN.test(candidate.id) ||
        typeof candidate.displayName !== 'string' || !candidate.displayName.trim()) return [];
    const id = candidate.id.toLowerCase();
    if (seen.has(id)) return [];
    seen.add(id);
    return [{ id, displayName: candidate.displayName.trim().slice(0, 80) }];
  }).slice(0, 100);
}

export function normalizeGiftCatalog(value: unknown): GiftCatalogItem[] {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('items' in value)) return [];
  const items = (value as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  return items.flatMap((entry): GiftCatalogItem[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const item = entry as Partial<GiftCatalogItem>;
    if (typeof item.id !== 'string' || !UUID_PATTERN.test(item.id) ||
        typeof item.displayName !== 'string' || !item.displayName.trim() ||
        !['flowers', 'chocolate', 'confectionery', 'book', 'approved_gift'].includes(String(item.category)) ||
        !Number.isSafeInteger(item.itemPriceMinorUnits) || (item.itemPriceMinorUnits ?? 0) <= 0 ||
        !Number.isSafeInteger(item.deliveryFeeMinorUnits) || (item.deliveryFeeMinorUnits ?? -1) < 0 ||
        !Number.isSafeInteger(item.totalMinorUnits) || (item.totalMinorUnits ?? 0) <= 0 ||
        (item.itemPriceMinorUnits ?? 0) + (item.deliveryFeeMinorUnits ?? 0) !== item.totalMinorUnits ||
        typeof item.currency !== 'string' || !/^[A-Z]{3}$/.test(item.currency)) return [];
    const id = item.id.toLowerCase();
    if (seen.has(id)) return [];
    seen.add(id);
    return [{
      id,
      category: item.category as GiftCatalogItem['category'],
      displayName: item.displayName.trim().slice(0, 160),
      itemPriceMinorUnits: item.itemPriceMinorUnits as number,
      deliveryFeeMinorUnits: item.deliveryFeeMinorUnits as number,
      totalMinorUnits: item.totalMinorUnits as number,
      currency: item.currency
    }];
  }).slice(0, 50);
}

export const GiftCatalogPanel: React.FC = () => {
  const { t } = useLocale();
  const [matches, setMatches] = useState<GiftMatch[]>([]);
  const [selectedMatchId, setSelectedMatchId] = useState('');
  const [items, setItems] = useState<GiftCatalogItem[]>([]);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [matchesLoading, setMatchesLoading] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [matchesErrorKey, setMatchesErrorKey] = useState('');
  const [catalogErrorKey, setCatalogErrorKey] = useState('');
  const [requestErrorKey, setRequestErrorKey] = useState('');
  const matchRequestEpoch = useRef(0);
  const catalogRequestEpoch = useRef(0);
  const submitting = useRef(false);
  const sessionEpoch = useRef(0);
  const idempotencyKeys = useRef(new Map<string, string>());

  const loadMatches = useCallback(async () => {
    const epoch = ++matchRequestEpoch.current;
    setMatchesLoading(true);
    setMatchesErrorKey('');
    try {
      const response = await fetch('/api/gifts/matches', { credentials: 'include' });
      const payload: unknown = await response.json().catch(() => null);
      if (epoch !== matchRequestEpoch.current) return;
      if (!response.ok) {
        if (response.status === 401) throw new Error('giftCatalogSignInRequired');
        if (response.status === 402) throw new Error('giftCatalogPremiumRequired');
        throw new Error('giftCatalogLoadError');
      }
      const loaded = normalizeGiftMatches(payload);
      setMatches(loaded);
      setSelectedMatchId(current => current && loaded.some(match => match.id === current) ? current : (loaded[0]?.id ?? ''));
      if (!loaded.length) setItems([]);
      setNotice('');
      setRequestErrorKey('');
    } catch (error) {
      if (epoch === matchRequestEpoch.current) {
        setMatches([]);
        setItems([]);
        setMatchesErrorKey(error instanceof Error ? error.message : 'giftCatalogLoadError');
      }
    } finally {
      if (epoch === matchRequestEpoch.current) setMatchesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMatches();
    const refreshOnSession = () => {
      sessionEpoch.current += 1;
      submitting.current = false;
      setBusyItemId(null);
      matchRequestEpoch.current += 1;
      catalogRequestEpoch.current += 1;
      idempotencyKeys.current.clear();
      setMatches([]);
      setSelectedMatchId('');
      setItems([]);
      setNotice('');
      setMatchesErrorKey('');
      setCatalogErrorKey('');
      setRequestErrorKey('');
      void loadMatches();
    };
    window.addEventListener('vow:session-changed', refreshOnSession);
    return () => {
      window.removeEventListener('vow:session-changed', refreshOnSession);
      sessionEpoch.current += 1;
      submitting.current = false;
      matchRequestEpoch.current += 1;
      catalogRequestEpoch.current += 1;
    };
  }, [loadMatches]);

  useEffect(() => {
    const epoch = ++catalogRequestEpoch.current;
    if (!selectedMatchId) {
      setItems([]);
      setCatalogLoading(false);
      return () => { catalogRequestEpoch.current += 1; };
    }
    const controller = new AbortController();
    setCatalogLoading(true);
    setCatalogErrorKey('');
    setItems([]);
    void (async () => {
      try {
        const query = new URLSearchParams({ matchId: selectedMatchId });
        const response = await fetch('/api/gifts/catalog?' + query.toString(), {
          credentials: 'include',
          signal: controller.signal
        });
        const payload: unknown = await response.json().catch(() => null);
        if (epoch !== catalogRequestEpoch.current) return;
        if (!response.ok) {
          if (response.status === 401) throw new Error('giftCatalogSignInRequired');
          if (response.status === 402) throw new Error('giftCatalogPremiumRequired');
          throw new Error('giftCatalogLoadError');
        }
        setItems(normalizeGiftCatalog(payload));
      } catch (error) {
        if (controller.signal.aborted || epoch !== catalogRequestEpoch.current) return;
        setItems([]);
        setCatalogErrorKey(error instanceof Error ? error.message : 'giftCatalogLoadError');
      } finally {
        if (!controller.signal.aborted && epoch === catalogRequestEpoch.current) setCatalogLoading(false);
      }
    })();
    return () => {
      controller.abort();
      catalogRequestEpoch.current += 1;
    };
  }, [selectedMatchId, catalogRevision]);

  const money = (minorUnits: number, currency: string) =>
    formatMinorCurrency(minorUnits, currency) ?? t('giftOrdersPriceUnavailable');

  const categoryLabel = (category: GiftCatalogItem['category']) => {
    const labels: Record<GiftCatalogItem['category'], string> = {
      flowers: t('giftCatalogCategoryFlowers'),
      chocolate: t('giftCatalogCategoryChocolate'),
      confectionery: t('giftCatalogCategoryConfectionery'),
      book: t('giftCatalogCategoryBook'),
      approved_gift: t('giftCatalogCategoryOther')
    };
    return labels[category];
  };

  const submitRequest = async (item: GiftCatalogItem) => {
    if (!selectedMatchId || submitting.current) return;
    const actionEpoch = sessionEpoch.current;
    submitting.current = true;
    setBusyItemId(item.id);
    setNotice('');
    setRequestErrorKey('');
    const key = selectedMatchId + ':' + item.id;
    let idempotencyKey = idempotencyKeys.current.get(key);
    if (!idempotencyKey) {
      const nonce = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);
      idempotencyKey = 'gift-request-' + nonce;
      idempotencyKeys.current.set(key, idempotencyKey);
    }

    try {
      const response = await fetch('/api/gifts/orders', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId: selectedMatchId, catalogItemId: item.id, idempotencyKey })
      });
      if (!isCurrentGiftSessionAction(actionEpoch, sessionEpoch.current)) return;
      const payload: unknown = await response.json().catch(() => null);
      if (!isCurrentGiftSessionAction(actionEpoch, sessionEpoch.current)) return;
      if (!response.ok) {
        idempotencyKeys.current.delete(key);
        if (response.status === 401) throw new Error('giftCatalogSignInRequired');
        if (response.status === 402) throw new Error('giftCatalogPremiumRequired');
        if (response.status === 429) throw new Error('giftCatalogRateLimited');
        throw new Error('giftCatalogRequestUnavailable');
      }
      idempotencyKeys.current.delete(key);
      setNotice(t('giftCatalogRequestSent'));
      setRequestErrorKey('');
      window.dispatchEvent(new Event('vow:gift-orders-changed'));
      // The endpoint rechecks eligibility; after a successful pending request the
      // catalog may correctly become empty for this pair.
      setCatalogRevision(value => value + 1);
    } catch (error) {
      if (isCurrentGiftSessionAction(actionEpoch, sessionEpoch.current)) {
        setRequestErrorKey(error instanceof Error ? error.message : 'giftCatalogRequestError');
      }
    } finally {
      if (isCurrentGiftSessionAction(actionEpoch, sessionEpoch.current)) {
        submitting.current = false;
        setBusyItemId(null);
      }
    }
  };

  return (
    <section className="mx-auto mt-4 w-full max-w-md rounded-2xl border border-white/10 bg-stone-900 p-4 text-left text-white" aria-labelledby="gift-catalog-title" aria-busy={matchesLoading || catalogLoading}>
      <h2 id="gift-catalog-title" className="text-lg font-semibold">{t('giftCatalogTitle')}</h2>
      <p className="mt-1 text-sm text-stone-300">{t('giftCatalogIntro')}</p>
      <p className="mt-2 text-xs text-stone-400">{t('giftCatalogPrivacy')}</p>
      {matchesLoading ? <p className="mt-3 text-sm text-stone-300" role="status">{t('giftCatalogLoading')}</p> : matchesErrorKey ? (
        <div className="mt-3">
          <p className="text-sm text-amber-200" role="status" aria-live="polite">{t(matchesErrorKey as never)}</p>
          <button type="button" onClick={() => void loadMatches()} className="mt-3 min-h-11 rounded-lg border border-white/20 px-3 py-2 text-sm hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300">{t('giftPreferencesRetry')}</button>
        </div>
      ) : matches.length === 0 ? (
        <p className="mt-3 rounded-xl border border-white/10 p-3 text-sm text-stone-300">{t('giftCatalogNoMatches')}</p>
      ) : (
        <>
          <label className="mt-4 block text-sm font-medium" htmlFor="gift-catalog-match">{t('giftCatalogMatchLabel')}</label>
          <select id="gift-catalog-match" value={selectedMatchId} onChange={event => { setSelectedMatchId(event.target.value); setNotice(''); setCatalogErrorKey(''); setRequestErrorKey(''); }} className="mt-2 min-h-11 w-full rounded-xl border border-white/15 bg-stone-950 px-3 py-2 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300">
            {matches.map(match => <option key={match.id} value={match.id}>{match.displayName}</option>)}
          </select>
          {catalogLoading ? <p className="mt-3 text-sm text-stone-300" role="status">{t('giftCatalogLoading')}</p> : catalogErrorKey ? (
            <div className="mt-3 rounded-xl border border-white/10 p-3">
              <p className="text-sm text-amber-200" role="status" aria-live="polite">{t(catalogErrorKey as never)}</p>
              <button type="button" onClick={() => setCatalogRevision(value => value + 1)} className="mt-3 min-h-11 rounded-lg border border-white/20 px-3 py-2 text-sm hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300">{t('giftPreferencesRetry')}</button>
            </div>
          ) : items.length === 0 ? (
            <p className="mt-3 rounded-xl border border-white/10 p-3 text-sm text-stone-300">{t('giftCatalogNoItems')}</p>
          ) : (
            <ul className="mt-3 space-y-3">
              {items.map(item => (
                <li key={item.id} className="rounded-xl border border-white/10 p-3">
                  <p className="text-xs uppercase tracking-wide text-rose-300">{categoryLabel(item.category)}</p>
                  <h3 className="mt-1 break-words text-sm font-semibold">{item.displayName}</h3>
                  <dl className="mt-2 space-y-1 text-xs text-stone-300">
                    <div className="flex items-start justify-between gap-3"><dt>{t('giftCatalogItemPrice')}</dt><dd className="text-right">{money(item.itemPriceMinorUnits, item.currency)}</dd></div>
                    <div className="flex items-start justify-between gap-3"><dt>{t('giftCatalogDeliveryFee')}</dt><dd className="text-right">{money(item.deliveryFeeMinorUnits, item.currency)}</dd></div>
                    <div className="flex items-start justify-between gap-3 border-t border-white/10 pt-2 font-semibold text-white"><dt>{t('giftCatalogTotal')}</dt><dd className="text-right">{money(item.totalMinorUnits, item.currency)}</dd></div>
                  </dl>
                  <button type="button" disabled={busyItemId !== null} onClick={() => void submitRequest(item)} className="mt-3 min-h-11 w-full rounded-xl bg-rose-700 px-3 py-2 text-sm font-semibold hover:bg-rose-600 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300">
                    {busyItemId === item.id ? t('giftCatalogSending') : t('giftCatalogSendRequest')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {notice && <p className="mt-3 text-sm text-stone-200" role="status" aria-live="polite">{notice}</p>}
      {requestErrorKey && matches.length > 0 && !matchesLoading && <p className="mt-3 text-sm text-amber-200" role="status" aria-live="polite">{t(requestErrorKey as never)}</p>}
    </section>
  );
};
