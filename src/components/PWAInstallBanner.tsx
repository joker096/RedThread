import React, { useEffect, useState } from 'react';
import { useLocale } from '../i18n/LocaleProvider';
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

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

interface PWAInstallBannerProps {
  onDismiss?: () => void;
}

export const PWAInstallBanner: React.FC<PWAInstallBannerProps> = ({ onDismiss }) => {
  const { t } = useLocale();
  const [installed, setInstalled] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches
  );
  const [isOpen, setIsOpen] = useState(() => {
    if (typeof window === 'undefined') return true;
    if (window.matchMedia('(display-mode: standalone)').matches) return false;
    try {
      return window.localStorage.getItem('nit-install-banner-dismissed') !== '1';
    } catch {
      return true;
    }
  });
  const [showGuide, setShowGuide] = useState(false);
  const [activeGuide, setActiveGuide] = useState<'ios' | 'android'>('ios');
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);

  useEffect(() => {
    setActiveGuide(/android/i.test(navigator.userAgent) ? 'android' : 'ios');
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const handleInstalled = () => {
      setInstalled(true);
      setInstallPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleInstalled);
    };
  }, []);

  if (!isOpen) return null;

  const handleInstall = async () => {
    if (!installPrompt) {
      setShowGuide(true);
      return;
    }
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === 'accepted') setInstalled(true);
    setInstallPrompt(null);
  };

  return (
    <div role="region" aria-label={t('installBannerTitle')} className="vow-install-banner w-full bg-gradient-to-r from-stone-950 via-rose-950/40 to-stone-950 border-b border-rose-900/30 px-3 py-1.5 text-left">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-6 h-6 rounded-lg bg-rose-600 flex items-center justify-center text-white shrink-0 shadow-sm">
            <Smartphone className="w-3.5 h-3.5" />
          </div>
          <div className="truncate">
            <span className="font-bold text-white text-[11px] sm:text-xs">{t('installBannerTitle')}</span>
            <span className="text-stone-400 hidden lg:inline ml-2 text-[11px]">
              {t('installBannerNote')}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowGuide(!showGuide)}
            aria-expanded={showGuide}
            aria-controls="vow-install-guide"
            className="min-h-8 rounded-lg border border-white/5 bg-stone-900 px-2 py-1 text-[11px] text-rose-300 hover:text-white"
          >
            {showGuide ? t('installGuideHide') : t('installGuideShow')}
          </button>

          {installed ? (
            <span role="status" className="px-2 py-0.5 rounded text-[11px] bg-emerald-950 text-emerald-300 font-bold border border-emerald-500/30 flex items-center gap-1">
              <Check className="w-3 h-3" />
              <span>{t('installInstalled')}</span>
            </span>
          ) : installPrompt ? (
            <button
              type="button"
              onClick={handleInstall}
              className="flex min-h-8 items-center gap-1 rounded-lg bg-rose-600 px-2.5 py-1 text-[11px] font-bold text-white shadow-sm hover:bg-rose-500"
            >
              <Download className="w-3 h-3" />
              <span>{t('installButton')}</span>
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => {
              setIsOpen(false);
              try {
                window.localStorage.setItem('nit-install-banner-dismissed', '1');
              } catch {
                // Dismissal persistence is optional when storage is unavailable.
              }
              if (onDismiss) onDismiss();
            }}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-stone-500 hover:text-stone-300"
            aria-label={t('installDismiss')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Guide tip dropdown / mini bar */}
      {showGuide && (
        <div id="vow-install-guide" className="max-w-6xl mx-auto mt-1.5 pt-1.5 border-t border-white/5 text-[11px] text-stone-300 flex flex-wrap items-center justify-between gap-2 animate-in fade-in duration-150">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setActiveGuide('ios')}
              aria-pressed={activeGuide === 'ios'}
              className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                activeGuide === 'ios' ? 'bg-rose-600 text-white' : 'text-stone-400 bg-stone-900'
              }`}
            >
              iOS (iPhone)
            </button>
            <button
              type="button"
              onClick={() => setActiveGuide('android')}
              aria-pressed={activeGuide === 'android'}
              className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                activeGuide === 'android' ? 'bg-rose-600 text-white' : 'text-stone-400 bg-stone-900'
              }`}
            >
              Android
            </button>
          </div>

          <div className="text-[11px] text-stone-300">
            {activeGuide === 'ios' ? (
              <span>{t('installIosInstructions').split('{share}')[0]}<Share className="w-3 h-3 inline text-blue-400" />{t('installIosInstructions').split('{share}')[1]}</span>
            ) : (
              <span>{t('installAndroidInstructions')}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
