import React, { useEffect, useRef, useState } from 'react';
import { initializePaddle } from '@paddle/paddle-js';

type Plan = { id: '1month' | '3months' | 'lifetime'; priceId: string; billing: 'month' | 'quarter' | 'one-time' };
type PaddleConfig = { configured: boolean; environment: 'sandbox'; clientToken?: string; plans: Plan[] };
type PaddleRuntime = {
  Checkout: { open: (args: Record<string, unknown>) => void };
  PricePreview?: (args: Record<string, unknown>) => Promise<unknown>;
};
type PriceLabels = Record<string, string>;

const PLAN_LABELS: Record<Plan['id'], { title: string; description: string }> = {
  '1month': { title: 'Premium на 1 месяц', description: 'Месячный доступ' },
  '3months': { title: 'Premium на 3 месяца', description: 'Доступ на квартал' },
  lifetime: { title: 'Premium без ограничения срока', description: 'Разовый платёж, если этот тариф создан в Paddle' }
};

function formattedTotal(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const direct = record.formattedTotals;
  if (direct && typeof direct === 'object') {
    const totals = direct as Record<string, unknown>;
    for (const key of ['total', 'grandTotal', 'grand_total']) {
      if (typeof totals[key] === 'string') return totals[key] as string;
    }
  }
  const details = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : record;
  const detailTotals = details.details && typeof details.details === 'object'
    ? (details.details as Record<string, unknown>).totals as Record<string, unknown> | undefined : undefined;
  if (detailTotals) {
    for (const key of ['total', 'grandTotal', 'grand_total']) {
      if (typeof detailTotals[key] === 'string') return detailTotals[key] as string;
    }
  }
  const lineItems = details.lineItems || details.line_items;
  if (Array.isArray(lineItems) && lineItems.length > 0) {
    const item = lineItems[0] as Record<string, unknown>;
    const totals = item.formattedTotals && typeof item.formattedTotals === 'object'
      ? item.formattedTotals as Record<string, unknown> : null;
    if (totals && typeof totals.total === 'string') return totals.total;
  }
  return null;
}

export const PaddleSubscriptionPanel: React.FC<{ email: string }> = ({ email }) => {
  const [config, setConfig] = useState<PaddleConfig | null>(null);
  const [prices, setPrices] = useState<PriceLabels>({});
  const [loading, setLoading] = useState(true);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [premiumActive, setPremiumActive] = useState(false);
  const [premiumLifetime, setPremiumLifetime] = useState(false);
  const [billingManageable, setBillingManageable] = useState(false);
  const [billingNeedsAttention, setBillingNeedsAttention] = useState(false);
  const [portalBusy, setPortalBusy] = useState(false);
  const paddleRef = useRef<PaddleRuntime | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    const load = async () => {
      try {
        const [response, statusResponse] = await Promise.all([
          fetch('/api/paddle/config', { credentials: 'include' }),
          fetch('/api/billing/status', { credentials: 'include' })
        ]);
        const [next, status] = await Promise.all([
          response.json() as Promise<PaddleConfig>,
          statusResponse.json() as Promise<{ premiumActive?: boolean; premiumLifetime?: boolean }>
        ]);
        if (!response.ok || !statusResponse.ok) throw new Error('paddle_status_unavailable');
        if (!cancelled) {
          setPremiumActive(status.premiumActive === true);
          setPremiumLifetime(status.premiumLifetime === true);
          setBillingManageable(status.billingManageable === true);
          setBillingNeedsAttention(status.billingNeedsAttention === true);
        }
        if (!next.configured || next.environment !== 'sandbox' || !next.clientToken?.startsWith('test_')) {
          if (!cancelled) setConfig({ configured: false, environment: 'sandbox', plans: [] });
          return;
        }
        const paddle = await initializePaddle({ token: next.clientToken, environment: 'sandbox' });
        if (cancelled) return;
        if (!paddle) throw new Error('paddle_sdk_initialization_failed');
        paddleRef.current = paddle as unknown as PaddleRuntime;
        setConfig(next);

        const runtime = paddle as unknown as PaddleRuntime;
        if (typeof runtime.PricePreview === 'function') {
          const previews = await Promise.all(next.plans.map(async plan => {
            try {
              // No country is forced here: Paddle can localize using the visitor's IP.
              const preview = await runtime.PricePreview!({ items: [{ priceId: plan.priceId, quantity: 1 }] });
              return [plan.id, formattedTotal(preview)] as const;
            } catch {
              return [plan.id, null] as const;
            }
          }));
          if (!cancelled) setPrices(Object.fromEntries(previews.filter(entry => Boolean(entry[1])) as Array<readonly [string, string]>));
        }
      } catch {
        if (!cancelled) {
          setConfig({ configured: false, environment: 'sandbox', plans: [] });
          setNotice('Не удалось подключить Paddle Sandbox. Проверьте test-токен и настройки.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
      mountedRef.current = false;
    };
  }, []);


  const openCustomerPortal = async () => {
    if (portalBusy || !billingManageable) return;
    setPortalBusy(true);
    setNotice('');
    try {
      const response = await fetch('/api/paddle/portal', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      const result = await response.json() as { url?: string; error?: string };
      if (!response.ok || typeof result.url !== 'string') {
        throw new Error(result.error || 'paddle_portal_unavailable');
      }
      const portalUrl = new URL(result.url);
      if (portalUrl.protocol !== 'https:' || portalUrl.hostname !== 'customer-portal.paddle.com') {
        throw new Error('paddle_portal_url_invalid');
      }
      window.location.assign(portalUrl.toString());
    } catch {
      if (mountedRef.current) setNotice('Не удалось открыть управление подпиской Paddle. Попробуйте ещё раз.');
    } finally {
      if (mountedRef.current) setPortalBusy(false);
    }
  };

  const startCheckout = async (plan: Plan) => {
    if (busyPlan || !paddleRef.current) return;
    setBusyPlan(plan.id);
    setNotice('');
    try {
      const response = await fetch('/api/paddle/checkout', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: plan.id })
      });
      const result = await response.json() as { transactionId?: string; environment?: string; error?: string };
      if (!response.ok || !result.transactionId || result.environment !== 'sandbox') {
        if (response.status === 409 && result.error === 'premium_already_active') {
          if (mountedRef.current) {
            setPremiumActive(true);
            setNotice('Premium уже активен для этого аккаунта. Повторная оплата отключена.');
          }
          return;
        }
        throw new Error(result.error || 'paddle_checkout_unavailable');
      }
      paddleRef.current.Checkout.open({
        transactionId: result.transactionId,
        customer: email ? { email } : undefined,
        settings: {
          displayMode: 'overlay',
          variant: 'one-page',
          successUrl: new URL('/?billing=success', window.location.origin).toString()
        }
      });
    } catch {
      setNotice('Не удалось открыть тестовую оплату. Проверьте настройки Paddle Sandbox и попробуйте ещё раз.');
    } finally {
      if (mountedRef.current) setBusyPlan(null);
    }
  };

  return (
    <section aria-busy={loading || Boolean(busyPlan) || portalBusy} className="rounded-xl border border-rose-500/20 bg-rose-950/20 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold text-white">Vow Premium</h4>
          <p className="mt-1 text-xs leading-relaxed text-stone-300">Тестовое оформление подписки через Paddle Sandbox. Реальный платёж не выполняется.</p>
        </div>
        <span className="shrink-0 rounded-full border border-amber-400/30 px-2 py-1 text-[10px] font-semibold text-amber-200">SANDBOX</span>
      </div>
      {loading ? <p className="mt-3 text-xs text-stone-400">Подключаем тестовый checkout…</p> : premiumActive || billingNeedsAttention ? (
        <div className="mt-3">
          <p className="text-xs leading-relaxed text-emerald-300">
            {premiumActive
              ? (premiumLifetime ? 'Пожизненный Premium уже активен.' : 'Premium уже активен. Повторная покупка отключена.')
              : 'У существующей подписки есть незавершённое состояние. Повторная покупка отключена до сверки.'}
          </p>
          {billingManageable ? (
            <button type="button" onClick={() => void openCustomerPortal()} disabled={portalBusy} className="mt-3 min-h-11 w-full rounded-lg border border-amber-400/30 px-3 py-2 text-xs font-semibold text-amber-100 disabled:opacity-50">
              {portalBusy ? 'Открываем управление…' : 'Управлять подпиской и платежами'}
            </button>
          ) : (
            <p className="mt-2 text-xs text-amber-200">Управление подпиской временно недоступно. Обратитесь в поддержку для сверки платежа.</p>
          )}
        </div>
      ) : !config?.configured ? (
        <p className="mt-3 text-xs leading-relaxed text-stone-400">Paddle Sandbox пока не настроен. Добавьте test client token и Price ID тарифов в серверное окружение.</p>
      ) : (
        <div className="mt-3 grid gap-2">
          {config.plans.map(plan => (
            <div key={plan.id} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-stone-950/70 p-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-white">{PLAN_LABELS[plan.id].title}</p>
                <p className="mt-1 text-[10px] text-stone-400">{prices[plan.id] || 'Цена будет показана в Paddle Checkout'}</p>
              </div>
              <button type="button" onClick={() => void startCheckout(plan)} disabled={Boolean(busyPlan) || premiumActive} className="min-h-11 shrink-0 rounded-lg bg-rose-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
                {busyPlan === plan.id ? 'Открываем…' : 'Тестировать'}
              </button>
            </div>
          ))}
        </div>
      )}
      {notice && <p role="status" aria-live="polite" className="mt-2 text-xs text-amber-200">{notice}</p>}
      <p className="mt-2 text-[10px] leading-relaxed text-stone-500">Premium активируется только после проверки подписочного webhook. Возврат с checkout сам по себе доступ не открывает.</p>
    </section>
  );
};
