import React, { useEffect, useRef } from 'react';
import { Crown, Sparkles, ShieldCheck, Heart, X, Zap } from 'lucide-react';
import { PaddleSubscriptionPanel } from './PaddleSubscriptionPanel.tsx';

interface LadyPremiumModalProps { isOpen: boolean; onClose: () => void; }

export const LadyPremiumModal: React.FC<LadyPremiumModalProps> = ({ isOpen, onClose }) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusableSelector = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusableElements = () => Array.from(dialog?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])
      .filter(element => !element.closest('[aria-hidden="true"], [hidden], [inert]'));
    focusableElements()[0]?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const elements = focusableElements();
      if (!elements.length) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };

    dialog?.addEventListener('keydown', handleKeyDown);
    return () => {
      dialog?.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="vow-modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-stone-950/85 backdrop-blur-md overflow-y-auto animate-in fade-in duration-200">
      <div ref={dialogRef} role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby="premium-modal-title" aria-describedby="premium-modal-description" className="relative w-full max-w-lg rounded-3xl bg-stone-900 border border-amber-500/40 shadow-2xl p-5 sm:p-6 text-left my-auto">
        <button type="button" onClick={onClose} className="absolute top-4 right-4 min-h-11 min-w-11 p-2 rounded-full bg-stone-800 text-stone-400 hover:text-white transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300" aria-label="Закрыть"><X className="w-5 h-5" /></button>
        <div className="flex items-center gap-3 mb-4 pr-10">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-amber-500 via-amber-400 to-yellow-300 text-stone-950 flex items-center justify-center shadow-lg shadow-amber-950/50"><Crown className="w-7 h-7 fill-stone-950" /></div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 id="premium-modal-title" className="text-xl font-heading font-black text-white">Vow Premium</h2>
              <span className="text-[10px] font-bold uppercase tracking-wider bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded-full">Paddle Sandbox</span>
            </div>
            <p id="premium-modal-description" className="text-xs text-stone-400">Дополнительные инструменты для поиска серьёзных отношений</p>
          </div>
        </div>

        <div className="p-3.5 rounded-2xl bg-rose-950/40 border border-rose-800/30 mb-5 text-xs">
          <div className="font-bold text-rose-300 flex items-center gap-1.5 mb-1"><Heart className="w-3.5 h-3.5 text-rose-500 fill-rose-500" /><span>Безопасность и прозрачность</span></div>
          <p className="text-stone-300 text-[11px] leading-relaxed">Оплата не гарантирует серьёзность намерений других пользователей. Premium активируется только после подтверждения подписочного webhook; возврат из checkout сам по себе не открывает доступ.</p>
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

        <PaddleSubscriptionPanel email="" />
        <button type="button" onClick={onClose} className="mt-3 min-h-11 w-full rounded-xl border border-white/10 px-4 py-2.5 text-xs font-semibold text-stone-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300">Закрыть</button>
      </div>
    </div>
  );
};
