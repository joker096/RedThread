import React, { useEffect, useRef, useState } from 'react';
import { 
  X, 
  Sparkles, 
  CheckCircle, 
  AlertTriangle, 
  Heart, 
  ShieldCheck, 
  Flame,
  ArrowRight
} from 'lucide-react';
import type { UserProfile, CrucialAnswers } from '../types/index.ts';
import { calculateCompatibility } from '../utils/compatibility.ts';

interface CompatibilityMatrixModalProps {
  profile: UserProfile | null;
  myAnswers: CrucialAnswers;
  myIntent: string;
  myInterests: string[];
  isOpen: boolean;
  onClose: () => void;
  onStartChat: (profile: UserProfile) => void;
}

export const CompatibilityMatrixModal: React.FC<CompatibilityMatrixModalProps> = ({
  profile,
  myAnswers,
  myIntent,
  myInterests,
  isOpen,
  onClose,
  onStartChat
}) => {
  const [chemistryStep, setChemistryStep] = useState<number>(0);
  const [chemistryScoreBonus, setChemistryScoreBonus] = useState<number>(0);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setChemistryStep(0);
    setChemistryScoreBonus(0);
  }, [isOpen, profile?.id]);

  useEffect(() => {
    if (!isOpen || !profile) return;
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
    };
  }, [isOpen, profile, onClose]);

  if (!isOpen || !profile) return null;

  const compatibility = calculateCompatibility(myAnswers, myIntent, myInterests, profile);
  const displayScore = Math.min(99, compatibility.overallScore + chemistryScoreBonus);

  // Blitz chemistry test questions
  const blitzQuestions = [
    {
      q: 'Идеальный вечер пятницы после сложной недели?',
      options: [
        { label: 'Ужин дома вдвоем за бокалом вина и глубоким разговором', match: true },
        { label: 'Шумный бар или вечеринка с друзьями до утра', match: false },
        { label: 'Прогулка в парке или кино', match: true }
      ]
    },
    {
      q: 'Кто принимает финальное решение по крупным покупкам?',
      options: [
        { label: 'Вместе на семейном совете, уважая аргументы друг друга', match: true },
        { label: 'Каждый тратит только свои заработанные деньги', match: false },
        { label: 'Мужчина берет на себя основные расходы и ответственность', match: true }
      ]
    },
    {
      q: 'Если произошла размолвка или недопонимание?',
      options: [
        { label: 'Сразу спокойно обсуждаем вслух, без обид и молчанки', match: true },
        { label: 'Ждем сутки, пока само рассосется', match: false },
        { label: 'Обнимемся и переключимся на решение задачи', match: true }
      ]
    }
  ];

  const handleBlitzAnswer = (isMatch: boolean) => {
    if (isMatch) {
      setChemistryScoreBonus(prev => Math.min(5, prev + 2));
    }
    setChemistryStep(prev => prev + 1);
  };

  return (
    <div className="vow-modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-stone-950/85 backdrop-blur-md overflow-y-auto animate-in fade-in duration-200">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="compatibility-matrix-title" aria-describedby="compatibility-matrix-description" tabIndex={-1} className="relative w-full max-w-lg rounded-3xl bg-stone-900 border border-rose-900/50 shadow-2xl p-5 sm:p-6 text-left my-auto">
        {/* Close Button */}
        <button type="button"
          onClick={onClose}
          className="absolute top-4 right-4 rounded-full bg-stone-800 p-2 text-stone-400 transition-colors hover:bg-stone-700 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"
          aria-label="Закрыть"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Modal Header */}
        <div className="flex items-center gap-3 mb-5 pr-8">
          <div className="relative">
            <img
              src={profile.avatar}
              alt={profile.name}
              className="w-14 h-14 rounded-2xl object-cover ring-2 ring-rose-600 shadow-md"
            />
            <div className="absolute -bottom-1 -right-1 p-0.5 rounded-full bg-stone-900">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
            </div>
          </div>

          <div>
            <div className="flex items-center gap-2">
              <h2 id="compatibility-matrix-title" className="text-xl font-heading font-black text-white">{profile.name}, {profile.age}</h2>
              <span className="text-xs text-rose-400 bg-rose-950/60 px-2 py-0.5 rounded-full border border-rose-800/40 font-bold">
                {profile.city}
              </span>
            </div>
            <p id="compatibility-matrix-description" className="text-xs text-stone-400 mt-0.5">
              Матрица совместимости по 5 факторам брака
            </p>
          </div>
        </div>

        {/* Big Overall Score Indicator */}
        <div className="p-4 rounded-2xl bg-gradient-to-r from-rose-950/60 via-red-950/40 to-stone-950 border border-rose-600/30 mb-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-rose-600 to-red-500 text-white flex flex-col items-center justify-center font-black shadow-lg shadow-rose-950">
              <span className="text-xl leading-none">{displayScore}%</span>
              <span className="text-[9px] uppercase tracking-tighter opacity-80 mt-0.5">Индекс</span>
            </div>
            <div>
              <div className="text-sm font-bold text-white flex items-center gap-1.5">
                <span>{displayScore >= 85 ? 'Высочайшая гармония для брака' : 'Хорошая совместимость'}</span>
                <Flame className="w-4 h-4 text-amber-400 fill-amber-400" />
              </div>
              <p className="text-xs text-rose-300/90 mt-0.5">
                Ценности и долгосрочные цели совпадают
              </p>
            </div>
          </div>
        </div>

        {/* 5 Dimensions Progress Bars */}
        <div className="space-y-3 mb-5">
          <div className="text-xs font-bold text-stone-300 uppercase tracking-wider flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-rose-400" />
            <span>Детализация по ключевым сферам</span>
          </div>

          <div className="space-y-2.5 text-xs">
            {/* 1. Family & Kids */}
            <div>
              <div className="flex justify-between text-stone-300 mb-1">
                <span>Семья и дети (приоритет №1)</span>
                <span className="font-bold text-rose-400">{compatibility.familyGoalsMatch}%</span>
              </div>
              <div className="h-2 rounded-full bg-stone-800 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-rose-600 to-red-500 rounded-full transition-all duration-500"
                  style={{ width: `${compatibility.familyGoalsMatch}%` }}
                ></div>
              </div>
            </div>

            {/* 2. Values & Faith */}
            <div>
              <div className="flex justify-between text-stone-300 mb-1">
                <span>Жизненные ценности & Бюджет</span>
                <span className="font-bold text-rose-400">{compatibility.valuesMatch}%</span>
              </div>
              <div className="h-2 rounded-full bg-stone-800 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-rose-600 to-red-500 rounded-full transition-all duration-500"
                  style={{ width: `${compatibility.valuesMatch}%` }}
                ></div>
              </div>
            </div>

            {/* 3. Communication & Maturity */}
            <div>
              <div className="flex justify-between text-stone-300 mb-1">
                <span>Зрелость в конфликтах (без манипуляций)</span>
                <span className="font-bold text-rose-400">{compatibility.communicationMatch}%</span>
              </div>
              <div className="h-2 rounded-full bg-stone-800 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-rose-600 to-red-500 rounded-full transition-all duration-500"
                  style={{ width: `${compatibility.communicationMatch}%` }}
                ></div>
              </div>
            </div>

            {/* 4. Lifestyle & Routine */}
            <div>
              <div className="flex justify-between text-stone-300 mb-1">
                <span>Образ жизни & Совместный отдых</span>
                <span className="font-bold text-rose-400">{compatibility.lifestyleMatch}%</span>
              </div>
              <div className="h-2 rounded-full bg-stone-800 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-rose-600 to-red-500 rounded-full transition-all duration-500"
                  style={{ width: `${compatibility.lifestyleMatch}%` }}
                ></div>
              </div>
            </div>
          </div>
        </div>

        {/* Green Flags & Friction Points */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
          {/* Green Flags */}
          <div className="p-3.5 rounded-2xl bg-emerald-950/30 border border-emerald-500/20 text-xs">
            <div className="font-bold text-emerald-400 flex items-center gap-1.5 mb-2">
              <CheckCircle className="w-4 h-4 text-emerald-400" />
              <span>Зеленые флаги</span>
            </div>
            <ul className="space-y-1.5 text-stone-300 text-[11px]">
              {compatibility.greenFlags.map((flag, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <span className="text-emerald-400 font-bold">•</span>
                  <span>{flag}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Friction Points */}
          <div className="p-3.5 rounded-2xl bg-amber-950/20 border border-amber-500/20 text-xs">
            <div className="font-bold text-amber-400 flex items-center gap-1.5 mb-2">
              <AlertTriangle className="w-4 h-4 text-amber-400" />
              <span>На что обратить внимание</span>
            </div>
            <ul className="space-y-1.5 text-stone-300 text-[11px]">
              {compatibility.frictionPoints.length > 0 ? (
                compatibility.frictionPoints.map((fric, i) => (
                  <li key={i} className="flex items-start gap-1.5">
                    <span className="text-amber-400 font-bold">•</span>
                    <span>{fric}</span>
                  </li>
                ))
              ) : (
                <li className="text-stone-400">Существенных разногласий в ценностях не выявлено</li>
              )}
            </ul>
          </div>
        </div>

        {/* Interactive Blitz Chemistry Test */}
        <div className="rounded-2xl bg-stone-950/80 border border-white/10 p-3.5 mb-5 text-xs">
          <div className="flex items-center justify-between mb-2">
            <span className="font-bold text-white flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              <span>Экспресс-тест на химию (30 секунд)</span>
            </span>
            <span className="text-[10px] text-stone-400">
              {chemistryStep < blitzQuestions.length ? `Вопрос ${chemistryStep + 1} из 3` : 'Тест пройден!'}
            </span>
          </div>

          {chemistryStep < blitzQuestions.length ? (
            <div>
              <p className="text-stone-200 mb-2 font-medium">
                {blitzQuestions[chemistryStep].q}
              </p>
              <div className="space-y-1.5">
                {blitzQuestions[chemistryStep].options.map((opt, idx) => (
                  <button type="button"
                    key={idx}
                    onClick={() => handleBlitzAnswer(opt.match)}
                    className="w-full text-left p-2 rounded-xl bg-stone-900 hover:bg-rose-950/60 hover:border-rose-500/40 border border-white/5 text-stone-300 hover:text-white transition-all text-[11px]"
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="p-2.5 rounded-xl bg-rose-950/40 border border-rose-500/30 text-rose-200 flex items-center justify-between">
              <span>Ответы совпали по этому мини-тесту. Это ориентир для разговора, а не научный прогноз отношений.</span>
              <span className="text-[10px] font-bold text-white bg-rose-600 px-2 py-0.5 rounded-full">Ответы совпали</span>
            </div>
          )}
        </div>

        {/* Modal Action Footer */}
        <div className="flex items-center gap-3">
          <button type="button"
            onClick={onClose}
            className="flex-1 py-3 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-300 font-semibold text-xs transition-colors"
          >
            Закрыть
          </button>
          <button type="button"
            onClick={() => {
              onStartChat(profile);
              onClose();
            }}
            className="flex-2 py-3 rounded-xl bg-gradient-to-r from-rose-600 via-red-600 to-rose-700 hover:from-rose-500 hover:to-red-500 font-bold text-white text-xs flex items-center justify-center gap-2 red-glow transition-all"
          >
            <Heart className="w-4 h-4 fill-white" />
            <span>{profile.likedByCandidate ? 'Взаимная симпатия — открыть чат' : 'Отправить симпатию'}</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};
