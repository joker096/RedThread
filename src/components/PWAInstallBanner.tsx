import React, { useState } from 'react';
import { 
  Smartphone, 
  Download, 
  Share, 
  PlusSquare, 
  X, 
  Check, 
  Sparkles,
  Apple
} from 'lucide-react';

interface PWAInstallBannerProps {
  onDismiss?: () => void;
}

export const PWAInstallBanner: React.FC<PWAInstallBannerProps> = ({ onDismiss }) => {
  const [isOpen, setIsOpen] = useState(true);
  const [installed, setInstalled] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [activeGuide, setActiveGuide] = useState<'ios' | 'android'>('ios');

  if (!isOpen) return null;

  const handleSimulateInstall = () => {
    setInstalled(true);
    setTimeout(() => {
      setIsOpen(false);
      if (onDismiss) onDismiss();
    }, 2000);
  };

  return (
    <div className="w-full bg-gradient-to-r from-stone-950 via-rose-950/40 to-stone-950 border-b border-rose-900/30 px-3 py-1.5 text-left">
      <div className="max-w-6xl mx-auto flex items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-6 h-6 rounded-lg bg-rose-600 flex items-center justify-center text-white shrink-0 shadow-sm">
            <Smartphone className="w-3.5 h-3.5" />
          </div>
          <div className="truncate">
            <span className="font-bold text-white text-[11px] sm:text-xs">Установите «Красную Нить» на iOS и Android</span>
            <span className="text-stone-400 hidden lg:inline ml-2 text-[11px]">
              (PWA: без App Store, мгновенные пуши о свиданиях)
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => setShowGuide(!showGuide)}
            className="text-[11px] text-rose-300 hover:text-white px-2 py-0.5 rounded bg-stone-900 border border-white/5"
          >
            {showGuide ? 'Скрыть гид' : 'Как установить'}
          </button>

          {installed ? (
            <span className="px-2 py-0.5 rounded text-[11px] bg-emerald-950 text-emerald-300 font-bold border border-emerald-500/30 flex items-center gap-1">
              <Check className="w-3 h-3" />
              <span>Готово</span>
            </span>
          ) : (
            <button
              onClick={handleSimulateInstall}
              className="px-2.5 py-0.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-bold flex items-center gap-1 shadow-sm text-[11px]"
            >
              <Download className="w-3 h-3" />
              <span>Установить</span>
            </button>
          )}

          <button
            onClick={() => {
              setIsOpen(false);
              if (onDismiss) onDismiss();
            }}
            className="p-1 text-stone-500 hover:text-stone-300"
            aria-label="Закрыть баннер"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Guide tip dropdown / mini bar */}
      {showGuide && (
        <div className="max-w-6xl mx-auto mt-1.5 pt-1.5 border-t border-white/5 text-[11px] text-stone-300 flex flex-wrap items-center justify-between gap-2 animate-in fade-in duration-150">
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setActiveGuide('ios')}
              className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                activeGuide === 'ios' ? 'bg-rose-600 text-white' : 'text-stone-400 bg-stone-900'
              }`}
            >
              iOS (iPhone)
            </button>
            <button
              onClick={() => setActiveGuide('android')}
              className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                activeGuide === 'android' ? 'bg-rose-600 text-white' : 'text-stone-400 bg-stone-900'
              }`}
            >
              Android
            </button>
          </div>

          <div className="text-[11px] text-stone-300">
            {activeGuide === 'ios' ? (
              <span>Нажмите «Поделиться» <Share className="w-3 h-3 inline text-blue-400" /> в Safari и выберите <strong>«На экран „Домой“»</strong></span>
            ) : (
              <span>В Chrome нажмите меню ⋮ и выберите <strong>«Установить приложение»</strong></span>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
