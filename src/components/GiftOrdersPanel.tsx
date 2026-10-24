import React, { useCallback, useEffect, useState } from 'react';
import { useLocale } from '../i18n/LocaleProvider.tsx';

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
  const match = /^(\\d{4})-(\\d{2})-(\\d{2})(?:T(\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d{1,3}))?)?(Z|[+-]\\d{2}:\\d{2}))?$/i.exec(value);
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
    if (offsetHour > 23 || offsetMinute > 59) return null;
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
      || typeof order.totalMinorUnits !== 'number'
      || typeof order.currency !== 'string'
      || typeof order.createdAt !== 'string') return [];
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
      createdAt: order.createdAt,
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

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const response = await fetch('/api/gifts/orders', { credentials: 'include' });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(response.status === 401 ? t('giftOrdersSignInRequired') : t('giftOrdersLoadError'));
      }
      if (!payload || typeof payload !== 'object' || !('orders' in payload)) throw new Error(t('giftOrdersLoadError'));
      setOrders(normalizeGiftOrders(payload));
      setNotice('');
    } catch (error) {
      setLoadFailed(true);
      setNotice(error instanceof Error ? error.message : t('giftOrdersLoadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const submitDecision = async (order: GiftOrder, action: 'accept' | 'decline') => {
    setBusyReference(order.publicReference);
    setNotice('');
    try {
      const response = await fetch(`/api/gifts/orders/${encodeURIComponent(order.publicReference)}/decision`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(response.status === 409 ? t('giftOrdersStaleRequest') : t('giftOrdersDecisionError'));
      }
      setNotice(action === 'accept' ? t('giftOrdersAcceptedNoDelivery') : t('giftOrdersDeclined'));
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('giftOrdersDecisionError'));
    } finally {
      setBusyReference(null);
    }
  };

  const withdrawConsent = async (order: GiftOrder) => {
    if (!window.confirm(t('giftOrdersWithdrawConfirm'))) return;
    setBusyReference(order.publicReference);
    setNotice('');
    try {
      const response = await fetch(`/api/gifts/orders/${encodeURIComponent(order.publicReference)}/withdraw-consent`, {
        method: 'POST',
        credentials: 'include'
      });
      if (!response.ok) {
        throw new Error(response.status === 409 ? t('giftOrdersWithdrawUnavailable') : t('giftOrdersDecisionError'));
      }
      setNotice(t('giftOrdersConsentWithdrawn'));
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('giftOrdersDecisionError'));
    } finally {
      setBusyReference(null);
    }
  };

  const money = (order: GiftOrder) => {
    if (!Number.isSafeInteger(order.totalMinorUnits) || order.totalMinorUnits < 0 || !/^[A-Z]{3}$/.test(order.currency)) return t('giftOrdersPriceUnavailable');
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: order.currency }).format(order.totalMinorUnits / 100);
    } catch {
      return t('giftOrdersPriceUnavailable');
    }
  };

  const statusLabel = (status: string) => {
    const labels: Record<string, string> = {
      awaiting_recipient_consent: t('giftOrdersStatusPending'),
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
    <section className="mx-auto mt-4 w-full max-w-md rounded-2xl border border-white/10 bg-stone-900 p-4 text-left text-white" aria-labelledby="gift-orders-title">
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
