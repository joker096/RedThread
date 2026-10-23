import React, { useEffect, useRef, useState } from 'react';
import { Purchases } from '@revenuecat/purchases-js';

type RevenueCatConfig = {
  configured: boolean;
  apiKey?: string;
  entitlementId?: string;
  environment?: 'sandbox' | 'production';
};

type PurchasesInstance = ReturnType<typeof Purchases.configure>;
type RevenueCatPackage = NonNullable<
  Awaited<ReturnType<PurchasesInstance['getOfferings']>>['current']
>['availablePackages'][number];

let sharedPurchases: PurchasesInstance | null = null;
let sharedAppUserId: string | null = null;

async function getPurchases(apiKey: string, appUserId: string): Promise<PurchasesInstance> {
  if (!sharedPurchases) {
    sharedPurchases = Purchases.configure({ apiKey, appUserId });
    sharedAppUserId = appUserId;
  } else if (sharedAppUserId !== appUserId) {
    await sharedPurchases.changeUser(appUserId);
    sharedAppUserId = appUserId;
  }
  return sharedPurchases;
}

function productDetails(pkg: RevenueCatPackage) {
  const product = pkg.product as unknown as Record<string, unknown>;
  const currentPrice = product.currentPrice && typeof product.currentPrice === 'object'
    ? product.currentPrice as Record<string, unknown> : {};
  const price = product.price && typeof product.price === 'object'
    ? product.price as Record<string, unknown> : {};
  const title = typeof product.title === 'string' && product.title.trim()
    ? product.title : pkg.identifier;
  const formattedPrice = [currentPrice.formattedPrice, price.formatted, price.formattedPrice, product.priceString]
    .find(value => typeof value === 'string' && value.trim());
  return {
    title,
    formattedPrice: typeof formattedPrice === 'string' ? formattedPrice : null
  };
}

export const RevenueCatSubscriptionPanel: React.FC<{
  userId: string;
  email: string;
  onEntitlementUpdated: () => void;
}> = ({ userId, email, onEntitlementUpdated }) => {
  const [config, setConfig] = useState<RevenueCatConfig | null>(null);
  const [packages, setPackages] = useState<RevenueCatPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyPackage, setBusyPackage] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    setConfig(null);
    setPackages([]);
    setNotice('');
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch('/api/revenuecat/config', { credentials: 'include' });
        const next = await response.json() as RevenueCatConfig;
        if (!response.ok || !next.configured || !next.apiKey?.startsWith('rcb_') || !next.entitlementId) {
          if (!cancelled) setConfig({ configured: false });
          return;
        }

        const purchases = await getPurchases(next.apiKey, userId);
        const offerings = await purchases.getOfferings();
        if (cancelled) return;
        setConfig(next);
        setPackages(offerings.current?.availablePackages || []);
        if (!offerings.current?.availablePackages.length) {
          setNotice('Тарифы Premium ещё не добавлены в RevenueCat.');
        }
      } catch {
        if (!cancelled) {
          setConfig({ configured: false });
          setNotice('Не удалось загрузить тарифы RevenueCat. Проверьте настройки веб-подписок.');
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
  }, [userId]);

  const refreshAccess = async () => {
    const response = await fetch('/api/billing/status', { credentials: 'include' });
    if (response.ok) {
      const status = await response.json() as { access?: string };
      if (status.access === 'full') {
        onEntitlementUpdated();
        return true;
      }
    }
    return false;
  };

  const startPurchase = async (pkg: RevenueCatPackage) => {
    if (busyPackage || !config?.apiKey) return;
    setBusyPackage(pkg.identifier);
    setNotice('');
    try {
      const purchases = await getPurchases(config.apiKey, userId);
      await purchases.purchase({ rcPackage: pkg, customerEmail: email });
      setNotice('Платёж принят. Подтверждаем подписку; это может занять несколько секунд.');
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (await refreshAccess()) {
          setNotice('Premium активирован.');
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      setNotice('Покупка завершена. Premium включится после получения подтверждения от RevenueCat.');
    } catch {
      if (mountedRef.current) {
        setNotice('Не удалось завершить оплату. Проверьте подключение и попробуйте ещё раз.');
      }
    } finally {
      if (mountedRef.current) setBusyPackage(null);
    }
  };

  return (
    <section aria-busy={loading || Boolean(busyPackage)} className="rounded-xl border border-rose-500/20 bg-rose-950/20 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold text-white">Vow Premium</h4>
          <p className="mt-1 text-xs leading-relaxed text-stone-300">Подписка оформляется через Paddle и синхронизируется с доступом приложения через RevenueCat.</p>
        </div>
        <span className="shrink-0 rounded-full border border-amber-400/30 px-2 py-1 text-[10px] font-semibold text-amber-200">
          {config?.environment === 'production' ? 'LIVE' : 'SANDBOX'}
        </span>
      </div>
      {loading ? <p className="mt-3 text-xs text-stone-400">Загружаем тарифы…</p> : !config?.configured ? (
        <p className="mt-3 text-xs leading-relaxed text-stone-400">Покупки пока не настроены. Добавьте публичный Web Billing API key RevenueCat и настройте Paddle Billing в кабинете RevenueCat.</p>
      ) : packages.length ? (
        <div className="mt-3 grid gap-2">
          {packages.map(pkg => {
            const product = productDetails(pkg);
            return (
              <div key={pkg.identifier} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-stone-950/70 p-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-white">{product.title}</p>
                  <p className="mt-1 text-[10px] text-stone-400">{product.formattedPrice || 'Итоговая цена будет показана при оплате'}</p>
                </div>
                <button type="button" onClick={() => void startPurchase(pkg)} disabled={Boolean(busyPackage)} className="min-h-11 shrink-0 rounded-lg bg-rose-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
                  {busyPackage === pkg.identifier ? 'Оформляем…' : 'Продолжить'}
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      {notice && <p role="status" aria-live="polite" className="mt-2 text-xs text-amber-200">{notice}</p>}
      <p className="mt-2 text-[10px] leading-relaxed text-stone-500">Доступ выдаётся сервером после проверки текущего entitlements в RevenueCat. Возврат из checkout сам по себе Premium не включает.</p>
    </section>
  );
};


