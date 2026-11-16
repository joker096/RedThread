import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '../i18n/LocaleProvider.tsx';
import { formatMinorCurrency } from '../utils/currency.ts';

type GiftAddressDraft = {
  recipientName: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
  deliveryInstructions: string;
};

const EMPTY_GIFT_ADDRESS_DRAFT: GiftAddressDraft = {
  recipientName: '', phone: '', addressLine1: '', addressLine2: '',
  city: '', region: '', postalCode: '', countryCode: '', deliveryInstructions: ''
};

type GiftOrder = {
  publicReference: string;
  productName: string;
  productCategory: string;
  totalMinorUnits: number;
  currency: string;
  status: string;
  createdAt: string;
  estimatedDeliveryStart?: string | null;
  estimatedDeliveryEnd?: string | null;
  myRole: 'recipient' | 'sender';
};

function normalizeOptionalDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  // Accept only unambiguous ISO dates/timestamps; Date.parse alone accepts values such as "1".
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2}))?$/i.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() + 1 !== month || calendarDate.getUTCDate() !== day) return null;
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const offset = match[8];
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (offset && offset.toUpperCase() !== 'Z') {
    const offsetHour = Number(offset.slice(1, 3));
    const offsetMinute = Number(offset.slice(4, 6));
    // ISO 8601 civil offsets are limited to ±14:00.
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return null;
  }
  return value;
}

export function normalizeGiftOrders(value: unknown): GiftOrder[] {
  if (!value || typeof value !== 'object' || !('orders' in value)) return [];
  const orders = (value as { orders?: unknown }).orders;
  if (!Array.isArray(orders)) return [];
  return orders.flatMap((item): GiftOrder[] => {
    if (!item || typeof item !== 'object') return [];
    const order = item as Partial<GiftOrder>;
    if (typeof order.publicReference !== 'string' || !/^gift_[a-f0-9]{32}$/i.test(order.publicReference)
      || typeof order.productName !== 'string'
      || typeof order.productCategory !== 'string'
      || typeof order.status !== 'string'
      || (order.myRole !== 'recipient' && order.myRole !== 'sender')
      || typeof order.totalMinorUnits !== 'number' || !Number.isSafeInteger(order.totalMinorUnits) || order.totalMinorUnits <= 0
      || typeof order.currency !== 'string' || !/^[A-Z]{3}$/.test(order.currency)
      || typeof order.createdAt !== 'string') return [];
    const createdAt = normalizeOptionalDate(order.createdAt);
    if (!createdAt) return [];
    // Explicitly project the API response into the small display allowlist.
    // Accidental future fields (especially address/contact data) are discarded.
    const estimatedDeliveryStart = normalizeOptionalDate(order.estimatedDeliveryStart);
    let estimatedDeliveryEnd = normalizeOptionalDate(order.estimatedDeliveryEnd);
    // Never render an internally inconsistent delivery window from an untrusted API payload.
    if (estimatedDeliveryStart && estimatedDeliveryEnd
      && Date.parse(estimatedDeliveryEnd) < Date.parse(estimatedDeliveryStart)) {
      estimatedDeliveryEnd = null;
    }
    return [{
      publicReference: order.publicReference,
      productName: order.productName.slice(0, 160),
      productCategory: order.productCategory.slice(0, 80),
      totalMinorUnits: order.totalMinorUnits,
      currency: order.currency,
      status: order.status.slice(0, 64),
      createdAt,
      estimatedDeliveryStart,
      estimatedDeliveryEnd,
      myRole: order.myRole
    }];
  }).slice(0, 50);
}

export const GiftOrdersPanel: React.FC = () => {
  const { t } = useLocale();
  const [orders, setOrders] = useState<GiftOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyReference, setBusyReference] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [draftOrder, setDraftOrder] = useState<GiftOrder | null>(null);
  const [draftAddress, setDraftAddress] = useState<GiftAddressDraft>(EMPTY_GIFT_ADDRESS_DRAFT);
  const [draftConsent, setDraftConsent] = useState(false);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftNotice, setDraftNotice] = useState('');
  const loadRequestId = useRef(0);
  const sessionEpoch = useRef(0);
  const panelRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async (options?: { preserveNotice?: boolean }) => {
    const requestId = ++loadRequestId.current;
    setLoading(true);
    setLoadFailed(false);
    try {
      const response = await fetch('/api/gifts/orders', { credentials: 'include' });
      const payload: unknown = await response.json().catch(() => null);
      if (requestId !== loadRequestId.current) return;
      if (response.status === 401) {
        sessionEpoch.current += 1;
        setBusyReference(null);
        setOrders([]);
      }
      if (!response.ok) {
        throw new Error(response.status === 401 ? t('giftOrdersSignInRequired') : t('giftOrdersLoadError'));
      }
      if (!payload || typeof payload !== 'object' || !('orders' in payload)) throw new Error(t('giftOrdersLoadError'));
      setOrders(normalizeGiftOrders(payload));
      if (!options?.preserveNotice) setNotice('');
    } catch (error) {
      if (requestId !== loadRequestId.current) return;
      setLoadFailed(true);
      setNotice(error instanceof Error ? error.message : t('giftOrdersLoadError'));
    } finally {
      if (requestId === loadRequestId.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    const focusGiftOrders = () => {
      const element = panelRef.current;
      if (!element) return;
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      element.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
    };
    window.addEventListener('vow:open-gifts', focusGiftOrders);
    return () => window.removeEventListener('vow:open-gifts', focusGiftOrders);
  }, []);

  useEffect(() => {
    void load();
    const refresh = () => { void load(); };
    const sessionChanged = () => {
      sessionEpoch.current += 1;
      loadRequestId.current += 1;
      setOrders([]);
      setNotice('');
      setLoadFailed(false);
      setBusyReference(null);
      setDraftOrder(null);
      setDraftAddress(EMPTY_GIFT_ADDRESS_DRAFT);
      setDraftConsent(false);
      setDraftNotice('');
      void load();
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('vow:gift-orders-changed', refresh);
    window.addEventListener('vow:session-changed', sessionChanged);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('vow:gift-orders-changed', refresh);
      window.removeEventListener('vow:session-changed', sessionChanged);
      sessionEpoch.current += 1;
      loadRequestId.current += 1;
    };
  }, [load]);

  const submitDecision = async (order: GiftOrder, action: 'accept' | 'decline') => {
    const actionEpoch = sessionEpoch.current;
    setBusyReference(order.publicReference);
    setNotice('');
    try {
      const response = await fetch(`/api/gifts/orders/${encodeURIComponent(order.publicReference)}/decision`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      if (actionEpoch !== sessionEpoch.current) return;
      const payload: unknown = await response.json().catch(() => null);
      if (actionEpoch !== sessionEpoch.current) return;
      if (response.status === 401) {
        sessionEpoch.current += 1;
        loadRequestId.current += 1;
        setOrders([]);
        setLoadFailed(true);
        setLoading(false);
        setBusyReference(null);
        setNotice(t('giftOrdersSignInRequired'));
        return;
      }
      if (response.status === 409) {
        setNotice(t('giftOrdersStaleRequest'));
        await load({ preserveNotice: true });
        return;
      }
      if (!response.ok) {
        throw new Error(t('giftOrdersDecisionError'));
      }
      if (response.status === 202 && action === 'decline') {
        setNotice(t('giftOrdersDeclinePending'));
        await load({ preserveNotice: true });
        return;
      }
      setNotice(action === 'accept' ? t('giftOrdersAcceptedNoDelivery') : t('giftOrdersDeclined'));
      await load({ preserveNotice: true });
    } catch (error) {
      if (actionEpoch === sessionEpoch.current) {
        setNotice(error instanceof Error ? error.message : t('giftOrdersDecisionError'));
      }
    } finally {
      if (actionEpoch === sessionEpoch.current) setBusyReference(null);
    }
  };

  const withdrawConsent = async (order: GiftOrder) => {
    if (!window.confirm(t('giftOrdersWithdrawConfirm'))) return;
    const actionEpoch = sessionEpoch.current;
    setBusyReference(order.publicReference);
    setNotice('');
    try {
      const response = await fetch(`/api/gifts/orders/${encodeURIComponent(order.publicReference)}/withdraw-consent`, {
        method: 'POST',
        credentials: 'include'
      });
      if (actionEpoch !== sessionEpoch.current) return;
      if (response.status === 401) {
        sessionEpoch.current += 1;
        loadRequestId.current += 1;
        setOrders([]);
        setLoadFailed(true);
        setBusyReference(null);
        setNotice(t('giftOrdersSignInRequired'));
        return;
      }
      if (response.status === 409) {
        setNotice(t('giftOrdersWithdrawUnavailable'));
        await load({ preserveNotice: true });
        return;
      }
      if (!response.ok) {
        throw new Error(t('giftOrdersDecisionError'));
      }
      setNotice(t('giftOrdersConsentWithdrawn'));
      await load({ preserveNotice: true });
    } catch (error) {
      if (actionEpoch === sessionEpoch.current) {
        setNotice(error instanceof Error ? error.message : t('giftOrdersDecisionError'));
      }
    } finally {
      if (actionEpoch === sessionEpoch.current) setBusyReference(null);
    }
  };

  const closeAddressDraft = () => {
    setDraftOrder(null);
    setDraftAddress(EMPTY_GIFT_ADDRESS_DRAFT);
    setDraftConsent(false);
    setDraftNotice('');
  };

  const openAddressDraft = async (order: GiftOrder) => {
    const actionEpoch = sessionEpoch.current;
    setBusyReference(order.publicReference);
    setDraftOrder(order);
    setDraftAddress(EMPTY_GIFT_ADDRESS_DRAFT);
    setDraftConsent(false);
    setDraftLoading(true);
    setDraftNotice('');
    try {
      const response = await fetch(`/api/gifts/orders/${encodeURIComponent(order.publicReference)}/address-draft`, {
        credentials: 'include'
      });
      const payload: unknown = await response.json().catch(() => null);
      if (actionEpoch !== sessionEpoch.current) return;
      if (response.status === 404) return;
      if (response.status === 401) {
        sessionEpoch.current += 1;
        loadRequestId.current += 1;
        setOrders([]);
        setDraftOrder(null);
        setNotice(t('giftOrdersSignInRequired'));
        return;
      }
      if (response.status === 503) throw new Error(t('giftDraftStorageNotConfigured'));
      if (!response.ok || !payload || typeof payload !== 'object' || !('draft' in payload)) {
        throw new Error(response.status === 409 ? t('giftDraftNotAvailable') : t('giftDraftLoadError'));
      }
      const draft = (payload as { draft?: { address?: unknown } }).draft;
      const address = draft?.address;
      if (!address || typeof address !== 'object') throw new Error(t('giftDraftLoadError'));
      const record = address as Record<string, unknown>;
      const next = { ...EMPTY_GIFT_ADDRESS_DRAFT };
      for (const key of Object.keys(next) as (keyof GiftAddressDraft)[]) {
        const value = record[key];
        if (typeof value === 'string') next[key] = value.slice(0, key === 'deliveryInstructions' ? 300 : key === 'addressLine1' ? 200 : 120);
      }
      setDraftAddress(next);
      setDraftConsent(true);
    } catch (error) {
      if (actionEpoch === sessionEpoch.current) setDraftNotice(error instanceof Error ? error.message : t('giftDraftLoadError'));
    } finally {
      if (actionEpoch === sessionEpoch.current) {
        setDraftLoading(false);
        setBusyReference(null);
      }
    }
  };

  const saveAddressDraft = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draftOrder || !draftConsent) {
      setDraftNotice(t('giftDraftConsentRequired'));
      return;
    }
    const actionEpoch = sessionEpoch.current;
    setBusyReference(draftOrder.publicReference);
    setDraftNotice('');
    try {
      const response = await fetch(`/api/gifts/orders/${encodeURIComponent(draftOrder.publicReference)}/address-draft`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consent: true, consentVersion: 1, address: draftAddress })
      });
      if (actionEpoch !== sessionEpoch.current) return;
      const payload: unknown = await response.json().catch(() => null);
      if (response.status === 401) throw new Error(t('giftOrdersSignInRequired'));
      if (response.status === 503) throw new Error(t('giftDraftStorageNotConfigured'));
      if (!response.ok) {
        const code = payload && typeof payload === 'object' && 'error' in payload
          ? String((payload as { error?: unknown }).error) : '';
        throw new Error(code === 'gift_address_draft_consent_required'
          ? t('giftDraftConsentRequired')
          : code === 'gift_address_draft_not_available' ? t('giftDraftNotAvailable') : t('giftDraftSaveError'));
      }
      closeAddressDraft();
      setNotice(t('giftDraftSaved'));
      await load({ preserveNotice: true });
    } catch (error) {
      if (actionEpoch === sessionEpoch.current) setDraftNotice(error instanceof Error ? error.message : t('giftDraftSaveError'));
    } finally {
      if (actionEpoch === sessionEpoch.current) setBusyReference(null);
    }
  };

  const deleteAddressDraft = async () => {
    if (!draftOrder) return;
    const actionEpoch = sessionEpoch.current;
    setBusyReference(draftOrder.publicReference);
    setDraftNotice('');
    try {
      const response = await fetch(`/api/gifts/orders/${encodeURIComponent(draftOrder.publicReference)}/address-draft`, {
        method: 'DELETE', credentials: 'include'
      });
      if (actionEpoch !== sessionEpoch.current) return;
      if (response.status === 401) throw new Error(t('giftOrdersSignInRequired'));
      if (!response.ok) throw new Error(response.status === 409 ? t('giftDraftNotAvailable') : t('giftDraftSaveError'));
      closeAddressDraft();
      setNotice(t('giftDraftDeleted'));
    } catch (error) {
      if (actionEpoch === sessionEpoch.current) setDraftNotice(error instanceof Error ? error.message : t('giftDraftSaveError'));
    } finally {
      if (actionEpoch === sessionEpoch.current) setBusyReference(null);
    }
  };

  const updateDraftField = (field: keyof GiftAddressDraft, value: string) => {
    setDraftAddress(current => ({ ...current, [field]: field === 'countryCode' ? value.toUpperCase() : value }));
  };

  const money = (order: GiftOrder) =>
    formatMinorCurrency(order.totalMinorUnits, order.currency) ?? t('giftOrdersPriceUnavailable');

  const statusLabel = (status: string) => {
    const labels: Record<string, string> = {
      awaiting_recipient_consent: t('giftOrdersStatusPending'),
      decision_pending_reconciliation: t('giftOrdersDeclinePending'),
      recipient_accepted: t('giftOrdersStatusAccepted'),
      address_verified: t('giftOrdersStatusAccepted'),
      fulfilment_authorized: t('giftOrdersStatusProcessing'),
      dispatched: t('giftOrdersStatusProcessing'),
      delivered: t('giftOrdersStatusDelivered'),
      declined: t('giftOrdersStatusClosed'),
      expired: t('giftOrdersStatusClosed'),
      cancelled: t('giftOrdersStatusClosed'),
      blocked: t('giftOrdersStatusClosed'),
      reported: t('giftOrdersStatusClosed'),
      delivery_failed: t('giftOrdersStatusClosed'),
      refunded: t('giftOrdersStatusClosed'),
      refund_pending: t('giftOrdersStatusProcessing'),
      not_available: t('giftOrdersStatusClosed')
    };
    return labels[status] || t('giftOrdersStatusUnknown');
  };

  return (
    <section ref={panelRef} id="gift-orders-panel" className="mx-auto mt-4 w-full max-w-md scroll-mt-20 rounded-2xl border border-white/10 bg-stone-900 p-4 text-left text-white" aria-labelledby="gift-orders-title">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="gift-orders-title" className="text-lg font-semibold">{t('giftOrdersTitle')}</h2>
          <p className="mt-1 text-sm text-stone-300">{t('giftOrdersIntro')}</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading || busyReference !== null} className="min-h-11 shrink-0 rounded-lg border border-white/20 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300">{t('giftOrdersRefresh')}</button>
      </div>
      <p className="mt-2 text-xs text-stone-400">{t('giftOrdersPrivacy')}</p>
      {loading ? <p className="mt-3 text-sm text-stone-300" role="status">{t('giftOrdersLoading')}</p> : loadFailed ? (
        <button type="button" onClick={() => void load()} className="mt-3 min-h-11 rounded-lg border border-white/20 px-3 py-2 text-sm hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300">{t('giftPreferencesRetry')}</button>
      ) : orders.length === 0 ? <p className="mt-3 rounded-xl border border-white/10 p-3 text-sm text-stone-300">{t('giftOrdersEmpty')}</p> : (
        <ul className="mt-3 space-y-3">
          {orders.map(order => {
            const isPendingRecipient = order.myRole === 'recipient' && order.status === 'awaiting_recipient_consent';
            const canWithdraw = order.myRole === 'recipient' && ['recipient_accepted', 'address_verified'].includes(order.status);
            const canDraftAddress = order.myRole === 'recipient' && order.status === 'recipient_accepted';
            const showDraft = draftOrder?.publicReference === order.publicReference;
            const busy = busyReference === order.publicReference;
            return (
              <li key={order.publicReference} className="rounded-xl border border-white/10 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="break-words text-sm font-semibold">{order.productName}</h3>
                    <p className="mt-1 text-xs text-stone-400">{order.myRole === 'recipient' ? t('giftOrdersIncoming') : t('giftOrdersOutgoing')} · {money(order)}</p>
                  </div>
                  <span className="shrink-0 rounded-full border border-white/15 px-2 py-1 text-xs text-stone-200">{statusLabel(order.status)}</span>
                </div>
                {order.estimatedDeliveryStart && (
                  <p className="mt-2 text-xs text-stone-400">
                    {t('giftOrdersEstimate')}: {new Date(order.estimatedDeliveryStart).toLocaleDateString()}
                    {order.estimatedDeliveryEnd ? ` – ${new Date(order.estimatedDeliveryEnd).toLocaleDateString()}` : ''}
                  </p>
                )}
                {isPendingRecipient && (
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button type="button" disabled={busy || busyReference !== null} onClick={() => void submitDecision(order, 'accept')} className="min-h-11 rounded-xl bg-rose-700 px-3 py-2 text-sm font-semibold hover:bg-rose-600 disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300">{busy ? t('giftOrdersWorking') : t('giftOrdersAccept')}</button>
                    <button type="button" disabled={busy || busyReference !== null} onClick={() => void submitDecision(order, 'decline')} className="min-h-11 rounded-xl border border-white/20 px-3 py-2 text-sm font-semibold hover:bg-white/10 disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300">{t('giftOrdersDeclineAction')}</button>
                  </div>
                )}
                {canDraftAddress && !showDraft && (
                  <button type="button" disabled={busy || busyReference !== null} onClick={() => void openAddressDraft(order)} className="mt-3 min-h-11 w-full rounded-xl border border-rose-300/40 px-3 py-2 text-sm font-semibold hover:bg-rose-300/10 disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300">{t('giftDraftOpen')}</button>
                )}
                {showDraft && (
                  <div className="mt-3 rounded-xl border border-rose-300/20 bg-black/20 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="text-sm font-semibold">{t('giftDraftTitle')}</h4>
                      <button type="button" onClick={closeAddressDraft} className="min-h-9 rounded-lg px-2 text-xs text-stone-300 hover:bg-white/10">{t('giftDraftClose')}</button>
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-stone-300">{t('giftDraftPrivacy')}</p>
                    {draftLoading ? <p className="mt-3 text-sm text-stone-300" role="status">{t('giftOrdersLoading')}</p> : (
                      <form className="mt-3 space-y-2" onSubmit={event => void saveAddressDraft(event)}>
                        {([
                          ['recipientName', 'giftDraftRecipientName', true, 120, 'text'],
                          ['phone', 'giftDraftPhone', true, 24, 'tel'],
                          ['addressLine1', 'giftDraftAddressLine1', true, 200, 'text'],
                          ['addressLine2', 'giftDraftAddressLine2', false, 120, 'text'],
                          ['city', 'giftDraftCity', true, 120, 'text'],
                          ['region', 'giftDraftRegion', false, 120, 'text'],
                          ['postalCode', 'giftDraftPostalCode', false, 120, 'text'],
                          ['countryCode', 'giftDraftCountryCode', true, 2, 'text']
                        ] as const).map(([field, labelKey, required, maxLength, inputType]) => (
                          <label key={field} className="block text-xs text-stone-300">
                            <span className="mb-1 block">{t(labelKey)}</span>
                            <input type={inputType} required={required} maxLength={maxLength} value={draftAddress[field]} onChange={event => updateDraftField(field, event.target.value)} autoComplete="off" className="min-h-10 w-full rounded-lg border border-white/15 bg-stone-950 px-3 py-2 text-sm text-white outline-none focus:border-rose-300" />
                          </label>
                        ))}
                        <label className="block text-xs text-stone-300">
                          <span className="mb-1 block">{t('giftDraftInstructions')}</span>
                          <textarea maxLength={300} rows={2} value={draftAddress.deliveryInstructions} onChange={event => updateDraftField('deliveryInstructions', event.target.value)} className="w-full rounded-lg border border-white/15 bg-stone-950 px-3 py-2 text-sm text-white outline-none focus:border-rose-300" />
                        </label>
                        <label className="flex items-start gap-2 rounded-lg border border-white/10 p-2 text-xs leading-relaxed text-stone-200">
                          <input type="checkbox" checked={draftConsent} onChange={event => setDraftConsent(event.target.checked)} className="mt-0.5 size-4 shrink-0 accent-rose-600" />
                          <span>{t('giftDraftConsent')}</span>
                        </label>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          <button type="submit" disabled={busy || busyReference !== null || !draftConsent} className="min-h-11 rounded-xl bg-rose-700 px-3 py-2 text-sm font-semibold hover:bg-rose-600 disabled:opacity-60">{t('giftDraftSave')}</button>
                          <button type="button" disabled={busy || busyReference !== null} onClick={() => void deleteAddressDraft()} className="min-h-11 rounded-xl border border-amber-300/30 px-3 py-2 text-xs hover:bg-amber-300/10 disabled:opacity-60">{t('giftDraftDelete')}</button>
                        </div>
                      </form>
                    )}
                    {draftNotice && <p className="mt-2 text-xs text-amber-200" role="status" aria-live="polite">{draftNotice}</p>}
                  </div>
                )}
                {canWithdraw && (
                  <button type="button" disabled={busy || busyReference !== null} onClick={() => void withdrawConsent(order)} className="mt-3 min-h-11 w-full rounded-xl border border-amber-300/40 px-3 py-2 text-sm hover:bg-amber-300/10 disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300">{t('giftOrdersWithdrawConsent')}</button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {notice && <p className="mt-3 text-sm text-stone-200" role="status" aria-live="polite">{notice}</p>}
      <p className="mt-3 text-xs text-amber-200/80">{t('giftOrdersNotLive')}</p>
    </section>
  );
};
