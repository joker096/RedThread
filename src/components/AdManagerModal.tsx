import React, { useEffect, useRef, useState } from 'react';
import { 
  DollarSign, 
  Play, 
  Sparkles, 
  TrendingUp, 
  Zap, 
  CheckCircle, 
  X, 
  Eye, 
  Award,
  Layers
} from 'lucide-react';
import type { AdStats } from '../types/index.ts';

interface AdManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  stats: AdStats;
  onWatchRewardedAd: () => void;
  superLikesCount: number;
  boostActive: boolean;
}

export const AdManagerModal: React.FC<AdManagerModalProps> = ({
  isOpen,
  onClose,
  stats,
  onWatchRewardedAd,
  superLikesCount,
  boostActive
}) => {
  const [isPlayingVideo, setIsPlayingVideo] = useState(false);
  const [countdown, setCountdown] = useState(5);
  const [rewardClaimed, setRewardClaimed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      setIsPlayingVideo(false);
      setCountdown(5);
      return;
    }

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const getFocusable = () => dialog
      ? Array.from(dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        )).filter(element => element.getAttribute('aria-hidden') !== 'true')
      : [];
    getFocusable()[0]?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = getFocusable();
      if (!focusable.length) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const startRewardedSimulation = () => {
    setIsPlayingVideo(true);
    setRewardClaimed(false);
    setCountdown(5);

    if (timerRef.current) clearInterval(timerRef.current);
    let secondsRemaining = 5;
    timerRef.current = setInterval(() => {
      secondsRemaining -= 1;
      setCountdown(secondsRemaining);
      if (secondsRemaining <= 0) {
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = null;
        setIsPlayingVideo(false);
        setRewardClaimed(true);
        onWatchRewardedAd();
      }
    }, 1000);
  };

  return (
    <div className="vow-modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-stone-950/85 backdrop-blur-md overflow-y-auto animate-in fade-in duration-200">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="ad-manager-title" aria-describedby="ad-manager-description" tabIndex={-1} className="relative w-full max-w-lg rounded-3xl bg-stone-900 border border-amber-500/30 shadow-2xl p-5 sm:p-6 text-left my-auto">
        {/* Close Button */}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 p-2 rounded-full bg-stone-800 text-stone-400 hover:text-white transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"
          aria-label="Закрыть"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Modal Header */}
        <div className="flex items-center gap-3 mb-5 pr-8">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-amber-500 to-rose-600 text-stone-950 flex items-center justify-center shadow-lg shadow-amber-950/40">
            <DollarSign className="w-6 h-6 stroke-[2.5]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 id="ad-manager-title" className="text-xl font-heading font-black text-white">Монетизация & Реклама</h2>
              <span className="text-[10px] font-bold uppercase tracking-wider bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded-full">
                Ad Revenue Engine
              </span>
            </div>
            <p id="ad-manager-description" className="text-xs text-stone-400">
              Демонстрация монетизации. Реальная рекламная сеть не подключена.
            </p>
          </div>
        </div>

        {/* Rewarded Video Ad Interactive Trigger (Get Boost for Free) */}
        <div className="p-4 rounded-2xl bg-gradient-to-r from-rose-950/60 via-amber-950/40 to-stone-950 border border-amber-500/40 mb-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-white flex items-center gap-1.5">
              <Zap className="w-4 h-4 text-amber-400" />
              <span>Вознаграждаемая реклама (Rewarded Video)</span>
            </span>
            <span className="text-[10px] bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded font-bold">
              Альтернатива оплате
            </span>
          </div>

          <p className="text-xs text-stone-300 mb-3 leading-relaxed">
            В демонстрации можно запустить короткую симуляцию награды и получить <strong className="text-white">+3 Супер-симпатии</strong> и <strong className="text-white">Буст анкеты</strong> в рамках тестового сценария. Это не реальный рекламный показ.
          </p>

          {/* Current inventory */}
          <div className="flex items-center gap-3 mb-3 text-xs">
            <div className="px-3 py-1.5 rounded-xl bg-stone-900 border border-white/5 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              <span>Супер-симпатий: <strong className="text-white">{superLikesCount}</strong></span>
            </div>
            <div className="px-3 py-1.5 rounded-xl bg-stone-900 border border-white/5 flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-rose-400" />
              <span>Буст анкеты: <strong className={boostActive ? 'text-emerald-400' : 'text-stone-400'}>{boostActive ? 'Активен' : 'Не активен'}</strong></span>
            </div>
          </div>

          {isPlayingVideo ? (
            <div className="p-4 rounded-2xl bg-stone-950 border border-amber-500 text-center animate-pulse">
              <div className="text-xs font-bold text-amber-300 mb-1">Демонстрация рекламного сценария — реальный ролик не подключён</div>
              <div role="status" aria-live="polite" aria-atomic="true" className="text-2xl font-mono font-black text-white">{countdown} сек</div>
              <div className="text-[10px] text-stone-400 mt-1">Не закрывайте окно до начисления бонуса...</div>
            </div>
          ) : rewardClaimed ? (
            <div role="status" aria-live="polite" className="p-3 rounded-xl bg-emerald-950/80 border border-emerald-500/30 text-emerald-300 text-xs font-bold flex items-center justify-center gap-2">
              <CheckCircle className="w-4 h-4" />
              <span>Демо-награда добавлена локально. Рекламная сеть не подключена.</span>
            </div>
          ) : (
            <button
              type="button"
              onClick={startRewardedSimulation}
              className="w-full py-3 rounded-xl bg-gradient-to-r from-amber-500 to-rose-600 hover:from-amber-400 hover:to-rose-500 font-bold text-stone-950 text-xs flex items-center justify-center gap-2 shadow-lg transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"
            >
              <Play className="w-4 h-4 fill-stone-950" />
              <span>Протестировать просмотр ролика (Получить Буст)</span>
            </button>
          )}
        </div>

        {/* Live Ad Network Analytics Grid */}
        <div className="space-y-2 mb-5">
          <div className="text-xs font-bold text-stone-300 uppercase tracking-wider flex items-center gap-1.5">
            <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
            <span>Демо-статистика (рекламная сеть не подключена)</span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs">
            <div className="p-3 rounded-2xl bg-stone-950/70 border border-white/5">
              <div className="text-[10px] text-stone-400">Показы рекламы</div>
              <div className="text-lg font-heading font-black text-white mt-0.5">
                {stats.impressions.toLocaleString()}
              </div>
              <div className="text-[9px] text-stone-400 mt-0.5">Нет данных провайдера</div>
            </div>

            <div className="p-3 rounded-2xl bg-stone-950/70 border border-white/5">
              <div className="text-[10px] text-stone-400">Клики в демо</div>
              <div className="text-lg font-heading font-black text-white mt-0.5">
                {stats.clicks.toLocaleString()}
              </div>
              <div className="text-[9px] text-stone-400 mt-0.5">Не реальные рекламные клики</div>
            </div>

            <div className="p-3 rounded-2xl bg-stone-950/70 border border-white/5 col-span-2 sm:col-span-1">
              <div className="text-[10px] text-stone-400">Средний eCPM</div>
              <div className="text-lg font-heading font-black text-amber-400 mt-0.5">
                {stats.averageEcpmRub} ₽
              </div>
              <div className="text-[9px] text-stone-400 mt-0.5">Не подключено</div>
            </div>

            <div className="p-3 rounded-2xl bg-stone-950/70 border border-white/5 col-span-2 sm:col-span-2">
              <div className="text-[10px] text-stone-400">Доход от рекламы</div>
              <div className="text-xl font-heading font-black text-emerald-400 mt-0.5">
                {stats.estimatedRevenueRub.toLocaleString()} ₽
              </div>
              <div className="text-[10px] text-stone-400 mt-0.5">
                Доход не рассчитывается без данных рекламной сети
              </div>
            </div>

            <div className="p-3 rounded-2xl bg-stone-950/70 border border-white/5">
              <div className="text-[10px] text-stone-400">Rewarded видео</div>
              <div className="text-lg font-heading font-black text-white mt-0.5">
                {stats.rewardedWatched}
              </div>
              <div className="text-[9px] text-stone-400 mt-0.5">Симуляции</div>
            </div>
          </div>
        </div>

        {/* Formats Overview */}
        <div className="p-3.5 rounded-2xl bg-stone-950/50 border border-white/5 text-xs text-stone-300 mb-5">
          <div className="font-bold text-white mb-1.5 flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-rose-400" />
            <span>Форматы монетизации в приложении:</span>
          </div>
          <ul className="space-y-1 text-[11px] text-stone-400">
            <li>• <strong>Нативные спонсорские карточки</strong> в ленте (рестораны, цветы, романтические поездки).</li>
            <li>• <strong>Rewarded-ролики</strong>: получение бустов и супер-лайков бесплатно.</li>
            <li>• <strong>Lady VIP</strong>: платный переход, полностью отключающий любую рекламу.</li>
          </ul>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="w-full py-3 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-200 font-semibold text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"
        >
          Закрыть панель
        </button>
      </div>
    </div>
  );
};
