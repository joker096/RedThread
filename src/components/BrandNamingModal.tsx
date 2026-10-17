import React, { useEffect, useRef } from 'react';
import { 
  Flame, 
  Sparkles, 
  Check, 
  X, 
  Heart, 
  ShieldCheck, 
  Gem, 
  Home, 
  Users, 
  Compass,
  Zap
} from 'lucide-react';

export interface BrandOption {
  id: string;
  name: string;
  tagline: string;
  concept: string;
  whyItWorks: string;
  icon: 'twinheart' | 'flame' | 'vesta' | 'rubin' | 'union' | 'srodni' | 'tetatet';
}

export const brandOptions: BrandOption[] = [
  {
    id: 'vow',
    name: 'Vow',
    tagline: 'A promise to build a life together',
    concept: 'An international dating app for people seeking serious relationships, shared values and a future together.',
    whyItWorks: 'Short, memorable and understandable across international markets.',
    icon: 'twinheart'
  }
];

interface BrandNamingModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentBrandId: string;
  onSelectBrand: (brandId: string) => void;
}

export const BrandNamingModal: React.FC<BrandNamingModalProps> = ({
  isOpen,
  onClose,
  currentBrandId,
  onSelectBrand
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const getFocusable = () => dialog?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ) ?? [];
    getFocusable()[0]?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(getFocusable());
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
      previouslyFocused?.focus();
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-stone-950/85 backdrop-blur-md overflow-y-auto animate-in fade-in duration-200">
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="brand-naming-title" className="relative w-full max-w-xl rounded-3xl bg-stone-900 border border-rose-900/40 shadow-2xl p-5 sm:p-6 text-left my-auto">
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-2 rounded-full bg-stone-800 text-stone-400 hover:text-white transition-colors"
          aria-label="Закрыть"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Modal Header */}
        <div className="flex items-center gap-3 mb-4 pr-8">
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-tr from-rose-600 to-amber-500 text-white flex items-center justify-center shadow-lg shadow-rose-950/50 shrink-0">
            <Sparkles className="w-6 h-6" />
          </div>
          <div>
            <h2 id="brand-naming-title" className="text-xl font-heading font-black text-white">Продуманные названия бренда</h2>
            <p className="text-xs text-stone-400">
              Выберите концепцию — название и стиль приложения обновятся мгновенно
            </p>
          </div>
        </div>

        {/* Binary positioning reminder */}
        <div className="p-3 rounded-2xl bg-rose-950/30 border border-rose-800/30 mb-4 text-xs text-rose-200 flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-rose-400 shrink-0" />
          <span>
            <strong>Строгий бинарный формат:</strong> Только Мужчины ♂ и Женщины ♀ для создания семьи.
          </span>
        </div>

        {/* Brand Options List */}
        <div className="space-y-2.5 max-h-[58vh] overflow-y-auto pr-1 mb-5">
          {brandOptions.map(option => {
            const isSelected = option.id === currentBrandId;
            return (
              <div
                key={option.id}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                onClick={() => onSelectBrand(option.id)}
                onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectBrand(option.id); } }}
                className={`p-3.5 rounded-2xl border cursor-pointer transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300 ${
                  isSelected
                    ? 'bg-rose-950/50 border-rose-500 ring-2 ring-rose-500/20 text-white shadow-lg'
                    : 'bg-stone-950/60 border-white/5 hover:border-white/20 text-stone-300'
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <span className="font-heading font-black text-base tracking-wide text-white">
                      «{option.name}»
                    </span>
                    <span className="text-[11px] font-medium text-rose-400">
                      — {option.tagline}
                    </span>
                  </div>
                  {isSelected && (
                    <div className="w-6 h-6 rounded-full bg-rose-600 text-white flex items-center justify-center shrink-0">
                      <Check className="w-4 h-4 stroke-[3]" />
                    </div>
                  )}
                </div>

                <p className="text-xs text-stone-300 mb-1.5 leading-relaxed">
                  {option.concept}
                </p>

                <div className="text-[11px] text-stone-400 bg-stone-900/80 p-2 rounded-xl border border-white/5">
                  <strong className="text-white">Почему это работает:</strong> {option.whyItWorks}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <button
          onClick={onClose}
          className="w-full py-3 rounded-2xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs transition-colors shadow-lg shadow-rose-950"
        >
          Применить выбранное название
        </button>
      </div>
    </div>
  );
};
