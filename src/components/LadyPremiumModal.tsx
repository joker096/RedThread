import React, { useEffect, useState } from 'react';
import { Crown, Check, Sparkles, ShieldCheck, Heart, X, Zap, ArrowRight } from 'lucide-react';

interface LadyPremiumModalProps { isOpen: boolean; onClose: () => void; }
type Plan = '1month' | '3months' | 'lifetime';

export const LadyPremiumModal: React.FC<LadyPremiumModalProps> = ({ isOpen, onClose }) => {
  const [selectedPlan, setSelectedPlan] = useState<Plan>('3months');
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutNotice, setCheckoutNotice] = useState('');
  const [paymentConfigured, setPaymentConfigured] = useState(false);
  const [availablePlans, setAvailablePlans] = useState<string[]>([]);
  const [premiumActive, setPremiumActive] = useState(false);
  const [premiumLifetime, setPremiumLifetime] = useState(false);
  const [portalBusy, setPortalBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    fetch('/api/billing/status', { credentials: 'include' })
      .then(async response => {
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(response.status === 401 ? 'Войдите в аккаунт, чтобы оформить Premium.' : 'Не удалось проверить статус подписки.');
        if (active) {
          setPaymentConfigured(Boolean(data?.paymentConfigured));
          setAvailablePlans(Array.isArray(data?.availablePlans) ? data.availablePlans : []);
          setPremiumActive(Boolean(data?.premiumActive));
          setPremiumLifetime(Boolean(data?.premiumLifetime));
          setCheckoutNotice('');
        }
      })
      .catch(error => { if (active) { setPaymentConfigured(false); setAvailablePlans([]); setPremiumActive(false); setPremiumLifetime(false); setCheckoutNotice(error instanceof Error ? error.message : 'Войдите в аккаунт, чтобы оформить Premium.'); } });
    return () => { active = false; };
  }, [isOpen]);

  const manageSubscription = async () => {
    setPortalBusy(true); setCheckoutNotice('');
    try {
      const response = await fetch('/api/billing/portal', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(response.status === 401 ? 'Войдите в аккаунт.' : 'Управление подпиской пока недоступно.');
      if (typeof data?.url !== 'string' || !data.url.startsWith('https://billing.stripe.com/')) throw new Error('Платёжный провайдер вернул некорректную ссылку.');
      window.location.assign(data.url);
    } catch (error) {
      setCheckoutNotice(error instanceof Error ? error.message : 'Не удалось открыть управление подпиской.');
      setPortalBusy(false);
    }
  };

  const startCheckout = async () => {
    setCheckoutBusy(true); setCheckoutNotice('');
    try {
      const response = await fetch('/api/billing/checkout', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: selectedPlan })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 401) throw new Error('Войдите в аккаунт, чтобы оформить Premium.');
        if (data?.error === 'payment_not_configured') throw new Error('Этот тариф ещё не настроен в платёжной системе.');
        throw new Error('Не удалось создать платёжную сессию. Попробуйте позже.');
      }
      if (typeof data?.url !== 'string' || !data.url.startsWith('https://checkout.stripe.com/')) throw new Error('Платёжный провайдер вернул некорректную ссылку.');
      window.location.assign(data.url);
    } catch (error) {
      setCheckoutNotice(error instanceof Error ? error.message : 'Ошибка оплаты.');
      setCheckoutBusy(false);
    }
  };

  if (!isOpen) return null;
  return (
    <div className="vow-modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-stone-950/85 backdrop-blur-md overflow-y-auto animate-in fade-in duration-200">
      <div role="dialog" aria-modal="true" aria-labelledby="premium-modal-title" aria-describedby="premium-modal-description" aria-busy={checkoutBusy || portalBusy} className="vow-lady-premium-modal relative w-full max-w-lg rounded-3xl bg-stone-900 border border-amber-500/40 shadow-2xl p-5 sm:p-6 text-left my-auto">
        <button onClick={onClose} className="absolute top-4 right-4 p-2 rounded-full bg-stone-800 text-stone-400 hover:text-white transition-colors" aria-label="Закрыть"><X className="w-5 h-5" /></button>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-amber-500 via-amber-400 to-yellow-300 text-stone-950 flex items-center justify-center shadow-lg shadow-amber-950/50"><Crown className="w-7 h-7 fill-stone-950" /></div>
          <div>
            <div className="flex items-center gap-2 flex-wrap"><h2 id="premium-modal-title" className="text-xl font-heading font-black text-white">Vow Premium</h2><span className="text-[10px] font-bold uppercase tracking-wider bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded-full">{paymentConfigured ? 'Оплата через Stripe' : 'Оплата не настроена'}</span></div>
            <p id="premium-modal-description" className="text-xs text-stone-400">Дополнительные инструменты для поиска серьёзных отношений</p>
          </div>
        </div>
        <div className="p-3.5 rounded-2xl bg-rose-950/40 border border-rose-800/30 mb-5 text-xs">
          <div className="font-bold text-rose-300 flex items-center gap-1.5 mb-1"><Heart className="w-3.5 h-3.5 text-rose-500 fill-rose-500" /><span>Безопасность и прозрачность</span></div>
          <p className="text-stone-300 text-[11px] leading-relaxed">Оплата не гарантирует серьёзность намерений других пользователей. Доступ активируется только после подтверждения платёжного провайдера; интерфейсный демо-статус не выдаёт серверные права.</p>
        </div>
        <div className="space-y-2 mb-5">
          <div className="text-xs font-bold text-stone-300 uppercase tracking-wider">Возможности Premium:</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
            <div className="p-2.5 rounded-xl bg-stone-950/60 border border-white/5 flex items-start gap-2"><div className="p-1 rounded-lg bg-amber-500/20 text-amber-400 shrink-0"><Zap className="w-3.5 h-3.5" /></div><div><div className="font-bold text-white text-[11px]">Расширенный подбор</div><div className="text-[10px] text-stone-400">Дополнительные настройки поиска</div></div></div>
            <div className="p-2.5 rounded-xl bg-stone-950/60 border border-white/5 flex items-start gap-2"><div className="p-1 rounded-lg bg-emerald-500/20 text-emerald-400 shrink-0"><ShieldCheck className="w-3.5 h-3.5" /></div><div><div className="font-bold text-white text-[11px]">Тест совместимости</div><div className="text-[10px] text-stone-400">Сравнение заявленных ожиданий</div></div></div>
            <div className="p-2.5 rounded-xl bg-stone-950/60 border border-white/5 flex items-start gap-2"><div className="p-1 rounded-lg bg-rose-500/20 text-rose-400 shrink-0"><Heart className="w-3.5 h-3.5" /></div><div><div className="font-bold text-white text-[11px]">Взаимные совпадения</div><div className="text-[10px] text-stone-400">Без обещаний результата отношений</div></div></div>
            <div className="p-2.5 rounded-xl bg-stone-950/60 border border-white/5 flex items-start gap-2"><div className="p-1 rounded-lg bg-blue-500/20 text-blue-400 shrink-0"><Sparkles className="w-3.5 h-3.5" /></div><div><div className="font-bold text-white text-[11px]">Дополнительные функции</div><div className="text-[10px] text-stone-400">Набор зависит от тарифа</div></div></div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2.5 mb-5 text-center">
          <button type="button" aria-pressed={selectedPlan === '1month'} onClick={() => setSelectedPlan('1month')} className={`p-3 rounded-2xl border transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300 ${selectedPlan==='1month'?'bg-amber-950/40 border-amber-500 text-white':'bg-stone-950/40 border-white/5 text-stone-400'}`}><div className="text-[11px] font-bold">1 месяц</div><div className="text-base font-heading font-black text-white mt-1">990 ₽</div><div className="text-[9px] text-stone-400 mt-0.5">Подписка</div></button>
          <button type="button" aria-pressed={selectedPlan === '3months'} onClick={() => setSelectedPlan('3months')} className={`p-3 rounded-2xl border transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300 ${selectedPlan==='3months'?'bg-amber-950/40 border-amber-500 text-white':'bg-stone-950/40 border-white/5 text-stone-400'}`}><div className="text-[11px] font-bold">3 месяца</div><div className="text-base font-heading font-black text-white mt-1">1 990 ₽</div><div className="text-[9px] text-stone-400 mt-0.5">Подписка</div></button>
          <button type="button" aria-pressed={selectedPlan === 'lifetime'} onClick={() => setSelectedPlan('lifetime')} className={`p-3 rounded-2xl border transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300 ${selectedPlan==='lifetime'?'bg-amber-950/40 border-amber-500 text-white':'bg-stone-950/40 border-white/5 text-stone-400'}`}><div className="text-[11px] font-bold">Навсегда</div><div className="text-base font-heading font-black text-white mt-1">3 990 ₽</div><div className="text-[9px] text-stone-400 mt-0.5">Разовый платёж</div></button>
        </div>
        <div className="p-3 rounded-2xl bg-stone-950 border border-white/10 mb-4 flex items-center gap-2 text-xs text-stone-300">
          <Check className="w-4 h-4 text-emerald-400 shrink-0" />
          {premiumActive ? 'Premium активен для этого аккаунта.' : paymentConfigured && availablePlans.includes(selectedPlan) ? 'Доступ включится после подтверждённого webhook платёжного провайдера.' : 'Настройте Stripe API key, webhook secret и Price ID выбранного тарифа, чтобы принимать реальные платежи.'}
        </div>
        {checkoutNotice && <p role="status" aria-live="polite" className="mb-3 rounded-xl border border-amber-500/20 bg-amber-950/30 p-3 text-xs text-amber-200">{checkoutNotice}</p>}
        {premiumActive && !premiumLifetime && <button type="button" onClick={() => void manageSubscription()} disabled={portalBusy} className="mb-2 w-full rounded-2xl border border-amber-500/30 px-4 py-3 text-xs font-semibold text-amber-200 disabled:opacity-50">{portalBusy ? 'Открываем управление…' : 'Управлять или отменить подписку'}</button>}
        {premiumLifetime && <p className="mb-2 text-center text-xs text-emerald-300">Пожизненный Premium активен.</p>}
        <button type="button" onClick={() => void startCheckout()} disabled={checkoutBusy || premiumActive || !paymentConfigured || !availablePlans.includes(selectedPlan)} className="w-full py-3.5 rounded-2xl bg-gradient-to-r from-amber-500 via-amber-400 to-yellow-400 text-stone-950 font-heading font-black text-sm flex items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-50">
          <Crown className="w-5 h-5 fill-stone-950" /><span>{checkoutBusy ? 'Переходим к оплате…' : premiumActive ? 'Premium уже активен' : paymentConfigured && availablePlans.includes(selectedPlan) ? 'Перейти к безопасной оплате' : 'Оплата пока недоступна'}</span><ArrowRight className="w-4 h-4 stroke-[2.5]" />
        </button>
        <button type="button" onClick={onClose} className="mt-2 w-full rounded-xl border border-white/10 px-4 py-2.5 text-xs font-semibold text-stone-300">Закрыть</button>
      </div>
    </div>
  );
};
