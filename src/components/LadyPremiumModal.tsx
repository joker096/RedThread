import React, { useState } from 'react';
import { 
  Crown, 
  Check, 
  Sparkles, 
  ShieldCheck, 
  Heart, 
  X, 
  Zap, 
  Lock,
  ArrowRight
} from 'lucide-react';

interface LadyPremiumModalProps {
  isOpen: boolean;
  onClose: () => void;
  isLadyPremium: boolean;
  onToggleLadyPremium: () => void;
}

export const LadyPremiumModal: React.FC<LadyPremiumModalProps> = ({
  isOpen,
  onClose,
  isLadyPremium,
  onToggleLadyPremium
}) => {
  const [selectedPlan, setSelectedPlan] = useState<'1month' | '3months' | 'lifetime'>('3months');

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-stone-950/85 backdrop-blur-md overflow-y-auto animate-in fade-in duration-200">
      <div className="relative w-full max-w-lg rounded-3xl bg-stone-900 border border-amber-500/40 shadow-2xl p-5 sm:p-6 text-left my-auto">
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-2 rounded-full bg-stone-800 text-stone-400 hover:text-white transition-colors"
          aria-label="Закрыть"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Header with Crown */}
        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-amber-500 via-amber-400 to-yellow-300 text-stone-950 flex items-center justify-center shadow-lg shadow-amber-950/50">
            <Crown className="w-7 h-7 fill-stone-950" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-heading font-black text-white">Lady Premium Club</h2>
              <span className="text-[10px] font-bold uppercase tracking-wider bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded-full">
                VIP Для Женщин
              </span>
            </div>
            <p className="text-xs text-stone-400">
              Королевский отбор спутника жизни без пустых переписок
            </p>
          </div>
        </div>

        {/* Unique Philosophy Explanation Card */}
        <div className="p-3.5 rounded-2xl bg-rose-950/40 border border-rose-800/30 mb-5 text-xs">
          <div className="font-bold text-rose-300 flex items-center gap-1.5 mb-1">
            <Heart className="w-3.5 h-3.5 text-rose-500 fill-rose-500" />
            <span>Почему в «Красной Нити» платят только женщины?</span>
          </div>
          <p className="text-stone-300 text-[11px] leading-relaxed">
            В обычных сервисах мужчины платят за каждый свайп, из-за чего в поиске остаются случайные искатели легких встреч. Мы сделали вход для мужчин <strong className="text-white">100% бесплатным</strong> — это собирает лучший пул зрелых, надежных и занятых кандидатов для семьи. Женщины же получают эксклюзивные инструменты отбора и приоритетного показа.
          </p>
        </div>

        {/* Perks list */}
        <div className="space-y-2 mb-5">
          <div className="text-xs font-bold text-stone-300 uppercase tracking-wider">
            Привилегии статуса Lady VIP:
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
            <div className="p-2.5 rounded-xl bg-stone-950/60 border border-white/5 flex items-start gap-2">
              <div className="p-1 rounded-lg bg-amber-500/20 text-amber-400 shrink-0">
                <Zap className="w-3.5 h-3.5" />
              </div>
              <div>
                <div className="font-bold text-white text-[11px]">Приоритет №1 в радаре</div>
                <div className="text-[10px] text-stone-400">Показываетесь первой топ-1% мужчинам</div>
              </div>
            </div>

            <div className="p-2.5 rounded-xl bg-stone-950/60 border border-white/5 flex items-start gap-2">
              <div className="p-1 rounded-lg bg-emerald-500/20 text-emerald-400 shrink-0">
                <ShieldCheck className="w-3.5 h-3.5" />
              </div>
              <div>
                <div className="font-bold text-white text-[11px]">Детектор намерений</div>
                <div className="text-[10px] text-stone-400">AI-анализ зрелости и правдивости анкеты</div>
              </div>
            </div>

            <div className="p-2.5 rounded-xl bg-stone-950/60 border border-white/5 flex items-start gap-2">
              <div className="p-1 rounded-lg bg-rose-500/20 text-rose-400 shrink-0">
                <Heart className="w-3.5 h-3.5" />
              </div>
              <div>
                <div className="font-bold text-white text-[11px]">Тайные поклонники</div>
                <div className="text-[10px] text-stone-400">Смотрите, кто вас лайкнул, до свайпа</div>
              </div>
            </div>

            <div className="p-2.5 rounded-xl bg-stone-950/60 border border-white/5 flex items-start gap-2">
              <div className="p-1 rounded-lg bg-blue-500/20 text-blue-400 shrink-0">
                <Sparkles className="w-3.5 h-3.5" />
              </div>
              <div>
                <div className="font-bold text-white text-[11px]">Отключение рекламы</div>
                <div className="text-[10px] text-stone-400">Чистый премиальный опыт без баннеров</div>
              </div>
            </div>
          </div>
        </div>

        {/* Pricing Tiers */}
        <div className="grid grid-cols-3 gap-2.5 mb-5 text-center">
          {/* 1 Month */}
          <div
            onClick={() => setSelectedPlan('1month')}
            className={`p-3 rounded-2xl border cursor-pointer transition-all ${
              selectedPlan === '1month'
                ? 'bg-amber-950/40 border-amber-500 text-white shadow-lg'
                : 'bg-stone-950/40 border-white/5 text-stone-400 hover:border-white/20'
            }`}
          >
            <div className="text-[11px] font-bold">1 месяц</div>
            <div className="text-base font-heading font-black text-white mt-1">990 ₽</div>
            <div className="text-[9px] text-stone-400 mt-0.5">33 ₽/день</div>
          </div>

          {/* 3 Months (Recommended) */}
          <div
            onClick={() => setSelectedPlan('3months')}
            className={`relative pt-4 pb-3 px-2 rounded-2xl border cursor-pointer transition-all ${
              selectedPlan === '3months'
                ? 'bg-gradient-to-b from-amber-950/60 to-rose-950/60 border-amber-400 text-white shadow-xl ring-2 ring-amber-400/30'
                : 'bg-stone-950/40 border-white/5 text-stone-400 hover:border-white/20'
            }`}
          >
            <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-gradient-to-r from-amber-500 to-rose-600 text-stone-950 text-[9px] font-black uppercase px-2.5 py-0.5 rounded-full tracking-wider whitespace-nowrap shadow-md">
              Хит • Выгода 35%
            </div>
            <div className="text-[11px] font-bold text-amber-300">3 месяца</div>
            <div className="text-base font-heading font-black text-white mt-1">1 990 ₽</div>
            <div className="text-[9px] text-stone-300 mt-0.5">663 ₽/мес</div>
          </div>

          {/* Lifetime */}
          <div
            onClick={() => setSelectedPlan('lifetime')}
            className={`p-3 rounded-2xl border cursor-pointer transition-all ${
              selectedPlan === 'lifetime'
                ? 'bg-amber-950/40 border-amber-500 text-white shadow-lg'
                : 'bg-stone-950/40 border-white/5 text-stone-400 hover:border-white/20'
            }`}
          >
            <div className="text-[11px] font-bold">Навсегда</div>
            <div className="text-base font-heading font-black text-white mt-1">3 990 ₽</div>
            <div className="text-[9px] text-stone-400 mt-0.5">Единоразово</div>
          </div>
        </div>

        {/* Instant Toggle Activation Demo Switch */}
        <div className="p-3 rounded-2xl bg-stone-950 border border-white/10 mb-5 flex items-center justify-between">
          <div>
            <div className="text-xs font-bold text-white">Статус подписки в приложении:</div>
            <div className="text-[10px] text-stone-400">
              {isLadyPremium ? 'Активирован (Все VIP привилегии включены)' : 'Не активен (Базовый тариф с рекламой)'}
            </div>
          </div>

          <button
            onClick={onToggleLadyPremium}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${
              isLadyPremium
                ? 'bg-amber-500 text-stone-950 hover:bg-amber-400'
                : 'bg-stone-800 text-stone-300 hover:text-white hover:bg-stone-700'
            }`}
          >
            {isLadyPremium ? 'Отключить VIP' : 'Включить VIP тест'}
          </button>
        </div>

        {/* CTA Button */}
        <button
          onClick={() => {
            if (!isLadyPremium) onToggleLadyPremium();
            onClose();
          }}
          className="w-full py-3.5 rounded-2xl bg-gradient-to-r from-amber-500 via-amber-400 to-yellow-400 hover:from-amber-400 hover:to-yellow-300 text-stone-950 font-heading font-black text-sm flex items-center justify-center gap-2 shadow-xl shadow-amber-950/50 transition-all hover:scale-[1.02] active:scale-95"
        >
          <Crown className="w-5 h-5 fill-stone-950" />
          <span>{isLadyPremium ? 'Сохранить и продолжить' : 'Оформить Lady VIP подписку'}</span>
          <ArrowRight className="w-4 h-4 stroke-[2.5]" />
        </button>
      </div>
    </div>
  );
};
