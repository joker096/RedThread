import React, { useEffect, useRef } from 'react';
import { 
  ShieldCheck, 
  UserCheck, 
  ScanFace, 
  FileCheck2, 
  X,
  Flag
} from 'lucide-react';
import type { UserProfile } from '../types/index.ts';

interface BotSafetyScannerProps {
  targetProfile: UserProfile | null;
  isOpen: boolean;
  onClose: () => void;
}

export const BotSafetyScanner: React.FC<BotSafetyScannerProps> = ({
  targetProfile,
  isOpen,
  onClose
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen || !targetProfile) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const dialog = dialogRef.current;
    const getFocusableElements = () => Array.from(
      dialog?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) ?? []
    ).filter(element =>
      !element.closest('[aria-hidden="true"], [hidden], [inert]') &&
      element.getAttribute('aria-hidden') !== 'true' &&
      element.getClientRects().length > 0
    );

    getFocusableElements()[0]?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;
      const focusable = getFocusableElements();
      if (focusable.length === 0) {
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
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [isOpen, targetProfile, onClose]);

  if (!isOpen || !targetProfile) return null;

  return (
    <div className="vow-modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-stone-950/85 backdrop-blur-md overflow-y-auto animate-in fade-in duration-200">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="bot-safety-title" aria-describedby="bot-safety-description" tabIndex={-1} className="relative w-full max-w-lg rounded-3xl bg-stone-900 border border-emerald-950/50 shadow-2xl p-5 sm:p-6 text-left my-auto">
        {/* Close Button */}
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 flex min-h-11 min-w-11 items-center justify-center rounded-full bg-stone-800 text-stone-400 transition-colors hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
          aria-label="Закрыть"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Modal Header */}
        <div className="flex items-center gap-3 mb-5 pr-8">
          <div className="w-12 h-12 rounded-2xl bg-stone-800 text-amber-300 flex items-center justify-center">
            <ScanFace className="w-6 h-6" />
          </div>
          <div>
            <h2 id="bot-safety-title" className="text-xl font-heading font-black text-white">Центр безопасности — демо</h2>
            <p id="bot-safety-description" className="text-xs text-stone-400">
              Профиль {targetProfile.name} загружен из демонстрационных данных. Проверка личности и серверная оценка риска не выполняются.
            </p>
          </div>
        </div>

        <div role="status" className="p-4 rounded-2xl bg-amber-950/30 border border-amber-500/30 mb-5">
          <p className="text-sm font-semibold text-amber-200">Нет подтверждённого результата проверки</p>
          <p className="mt-2 text-xs leading-relaxed text-stone-300">
            Показатели риска, биометрия, поведенческие сигналы и история жалоб для этого демонстрационного профиля недоступны. Отсутствие данных не означает, что профиль безопасен или проверен.
          </p>
        </div>

        {/* 4 Pillars of Automated Verification */}
        <div className="space-y-2.5 mb-5 text-xs">
          {/* 1. Liveness check */}
          <div className="p-2.5 rounded-xl bg-stone-950/60 border border-white/5 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <ScanFace className="w-4 h-4 text-emerald-400" />
              <div>
                <span className="text-white font-medium">Проверка личности (не подключена)</span>
                <p className="text-[10px] text-stone-400">Реальная проверка селфи и документов ещё не реализована</p>
              </div>
            </div>
            <span className="text-xs font-bold text-emerald-400 font-mono">
              Не подключено
            </span>
          </div>

          {/* 2. Neural Anti-Spam */}
          <div className="p-2.5 rounded-xl bg-stone-950/60 border border-white/5 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <div>
                <span className="text-white font-medium">Фильтр спама и внешних ссылок</span>
                <p className="text-[10px] text-stone-400">Локальная демонстрационная эвристика; серверная модерация не подключена</p>
              </div>
            </div>
            <span className="text-xs font-bold text-stone-400 font-mono">
              Нет данных
            </span>
          </div>

          {/* 3. Real Behavioral Patterns */}
          <div className="p-2.5 rounded-xl bg-stone-950/60 border border-white/5 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <UserCheck className="w-4 h-4 text-emerald-400" />
              <div>
                <span className="text-white font-medium">Поведенческие сигналы (не подключены)</span>
                <p className="text-[10px] text-stone-400">Серверная телеметрия действий пока не подключена</p>
              </div>
            </div>
            <span className="text-xs font-bold text-emerald-400 font-mono">
              Нет данных
            </span>
          </div>

          {/* 4. Rule Violations History */}
          <div className="p-2.5 rounded-xl bg-stone-950/60 border border-white/5 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <FileCheck2 className="w-4 h-4 text-emerald-400" />
              <div>
                <span className="text-white font-medium">Жалобы сообщества</span>
                <p className="text-[10px] text-stone-400">Тестовые данные профиля; реальная история жалоб не загружена</p>
              </div>
            </div>
            <span className="text-xs font-bold text-stone-400 font-mono">
              Нет данных
            </span>
          </div>
        </div>

        <div className="p-3.5 rounded-2xl bg-stone-950 border border-white/10 mb-5">
          <div className="flex items-center gap-2 text-xs font-bold text-stone-200">
            <Flag className="w-4 h-4 text-rose-400" />
            Жалобы для демонстрационных профилей не отправляются
          </div>
          <p className="mt-2 text-xs leading-relaxed text-stone-400">
            Серверный endpoint жалоб принимает только реальные идентификаторы аккаунтов. Этот экран показывает тестовые профили, поэтому кнопка отправки здесь намеренно отключена.
          </p>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="w-full min-h-11 py-3 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs transition-colors"
        >
          Закрыть
        </button>
      </div>
    </div>
  );
};
