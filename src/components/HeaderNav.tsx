import React from 'react';
import { SlidersHorizontal, Flame, MessageCircle, Brain, Crown, Sun, Moon } from 'lucide-react';
import type { DeviceFrame, Gender } from '../types/index.ts';
import { getTranslationCoverage, LANGUAGE_OPTIONS, useLocale } from '../i18n/LocaleProvider.tsx';

interface HeaderNavProps {
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  currentGender: Gender;
  isLadyPremium: boolean;
  deviceFrame: DeviceFrame;
  brandName: string;
  onOpenBrandModal: () => void;
  onToggleGender: () => void;
  onToggleDeviceFrame: (frame: DeviceFrame) => void;
  onOpenPremiumModal: () => void;
  onOpenBotScanner: () => void;
  onOpenAdManager: () => void;
  onOpenFilters: () => void;
  showFilters?: boolean;
  activeTab: 'discovery' | 'tests' | 'chats' | 'safety' | 'monetization';
  setActiveTab: (tab: 'discovery' | 'tests' | 'chats' | 'safety' | 'monetization') => void;
  unreadChatsCount: number;
}

export const HeaderNav: React.FC<HeaderNavProps> = ({
  theme,
  onToggleTheme,
  currentGender,
  isLadyPremium,
  deviceFrame,
  brandName,
  onOpenBrandModal,
  onToggleGender,
  onToggleDeviceFrame,
  onOpenPremiumModal,
  onOpenBotScanner,
  onOpenAdManager,
  onOpenFilters,
  showFilters = true,
  activeTab,
  setActiveTab,
  unreadChatsCount
}) => {
  const { t, locale, requestedLocale, setLocale } = useLocale();
  const activeTranslationCoverage = getTranslationCoverage(locale).percentage;
  return (
    <header className="sticky top-0 z-40 w-full border-b border-white/[0.07] bg-stone-950/90 px-3 py-2 backdrop-blur-2xl supports-[backdrop-filter]:bg-stone-950/75 sm:px-5">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-2 sm:gap-4">
        {/* NIT brand */}
        <div 
          className="flex items-center gap-1.5 select-none group shrink-0"
          title="Vow — serious relationships"
        >
          <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-gradient-to-tr from-rose-600 via-red-600 to-amber-500 flex items-center justify-center text-white shadow-md shadow-rose-950/60 group-hover:scale-105 transition-transform">
            <Flame className="w-3.5 h-3.5 sm:w-4 sm:h-4 fill-white" />
          </div>
          <div className="flex items-baseline gap-1">
            <span className="font-heading font-black tracking-tight text-sm sm:text-base text-white">
              Vow<span className="text-rose-500">.</span>
            </span>
          </div>
        </div>

        {/* Center: Sleek Segmented Navigation (Desktop & Tablet) */}
        <nav aria-label={t('primaryNavigation')} className="hidden lg:flex items-center gap-1 rounded-full border border-white/[0.07] bg-stone-900/90 p-1">
          <button
            onClick={() => setActiveTab('discovery')}
            aria-current={activeTab === 'discovery' ? 'page' : undefined}
            className={`px-3 py-1 rounded-full text-xs font-bold transition-all ${
              activeTab === 'discovery'
                ? 'bg-gradient-to-r from-rose-600 to-red-600 text-white shadow-sm'
                : 'text-stone-400 hover:text-stone-200'
            }`}
          >
            {t('discovery')}
          </button>

          <button
            onClick={() => setActiveTab('tests')}
            aria-current={activeTab === 'tests' ? 'page' : undefined}
            className={`flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold transition-all ${
              activeTab === 'tests'
                ? 'bg-gradient-to-r from-rose-600 to-red-600 text-white shadow-sm'
                : 'text-stone-400 hover:text-stone-200'
            }`}
          >
            <Brain className="w-3.5 h-3.5 text-rose-400" />
            <span>{t('tests')}</span>
          </button>

          <button
            data-testid="nav-chats"
            onClick={() => setActiveTab('chats')}
            aria-current={activeTab === 'chats' ? 'page' : undefined}
            className={`relative px-3 py-1 rounded-full text-xs font-bold transition-all ${
              activeTab === 'chats'
                ? 'bg-gradient-to-r from-rose-600 to-red-600 text-white shadow-sm'
                : 'text-stone-400 hover:text-stone-200'
            }`}
          >
            <span>{t('chats')}</span>
            {unreadChatsCount > 0 && (
              <span className="ml-1 px-1.5 py-0.2 rounded-full text-[9px] bg-amber-400 text-stone-950 font-black">
                {unreadChatsCount}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('safety')}
            aria-current={activeTab === 'safety' ? 'page' : undefined}
            className={`px-3 py-1 rounded-full text-xs font-bold transition-all ${
              activeTab === 'safety'
                ? 'bg-gradient-to-r from-rose-600 to-red-600 text-white shadow-sm'
                : 'text-stone-400 hover:text-stone-200'
            }`}
          >
            {t('safety')}
          </button>
        </nav>

        {/* Right: Quick Controls & Persona Toggle */}
        <div className="flex items-center gap-1 sm:gap-2">
          <button
            type="button"
            onClick={onToggleTheme}
            className="vow-motion-button flex min-h-10 min-w-10 shrink-0 items-center justify-center rounded-full border border-white/10 bg-stone-900 text-stone-200 transition-colors hover:border-rose-500/40"
            aria-label={theme === 'dark' ? t('switchToLightTheme') : t('switchToDarkTheme')}
            title={theme === 'dark' ? t('switchToLightTheme') : t('switchToDarkTheme')}
          >
            {theme === 'dark' ? <Sun className="h-4 w-4" aria-hidden="true" /> : <Moon className="h-4 w-4" aria-hidden="true" />}
          </button>
          <label className="sr-only" htmlFor="app-language">{t('language')}</label>
          <select
            id="app-language"
            value={requestedLocale}
            onChange={event => setLocale(event.target.value)}
            aria-label={t('language')}
            title={activeTranslationCoverage < 100 ? `${t('language')} — ${t('partialTranslationHelp')}` : t('language')}
            aria-description={activeTranslationCoverage < 100 ? t('partialTranslationHelp') : undefined}
            className="min-h-10 max-w-[88px] rounded-full border border-white/10 bg-stone-900 px-2 py-2 text-xs text-stone-200 sm:max-w-[132px]"
          >
            {LANGUAGE_OPTIONS.map(option => {
              const coverage = option.code === 'auto' ? 100 : getTranslationCoverage(option.code).percentage;
              const label = option.code === 'auto'
                ? t('autoLanguage')
                : `${option.nativeName}${coverage < 100 ? ` · ${coverage}%` : ''}`;
              return <option key={option.code} value={option.code}>{label}</option>;
            })}
          </select>
          {/* Binary Role Switcher */}
          <button
            onClick={onToggleGender}
            className={`vow-motion-button flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-2 text-[11px] font-semibold transition-all ${
              currentGender === 'female'
                ? 'bg-rose-950/40 border-rose-500/40 text-rose-200'
                : 'bg-blue-950/40 border-blue-500/40 text-blue-200'
            }`}
            title={t('demoModeToggleHelp')} aria-label={t('demoModeToggleHelp')}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${currentGender === 'female' ? 'bg-rose-500' : 'bg-blue-400'}`}></span>
            <span>{currentGender === 'female' ? `${t('demoWoman')} ♀` : `${t('demoMan')} ♂`}</span>
          </button>

          {/* Demo filters only: registered-account discovery has its own connected filters. */}
          {showFilters && <button
            onClick={onOpenFilters}
            className="vow-motion-button flex min-h-10 min-w-10 shrink-0 items-center justify-center rounded-full border border-white/10 bg-stone-900 text-stone-300 transition-colors hover:border-rose-500/40 hover:text-white"
            title={t('filters')}
            aria-label={t('filters')}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
          </button>}

          {currentGender === 'female' && (
            <button
              type="button"
              onClick={onOpenPremiumModal}
              className={`vow-motion-button hidden min-h-10 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-bold lg:flex ${
                isLadyPremium
                  ? 'bg-amber-400 text-stone-950'
                  : 'border border-rose-500/30 bg-rose-950/50 text-rose-100 hover:bg-rose-900/60'
              }`}
              aria-label={isLadyPremium ? 'VIP' : 'Lady VIP'}
            >
              <Crown className="h-3.5 w-3.5" />
              <span>{isLadyPremium ? 'VIP' : 'Lady VIP'}</span>
            </button>
          )}

        </div>
      </div>
    </header>
  );
};
