import React from 'react';
import { 
  Heart, 
  Crown, 
  ShieldCheck, 
  Smartphone, 
  Monitor, 
  Sparkles, 
  SlidersHorizontal,
  Flame,
  MessageCircle,
  Brain,
  DollarSign
} from 'lucide-react';
import type { DeviceFrame, Gender } from '../types/index.ts';
import { LANGUAGE_OPTIONS, useLocale } from '../i18n/LocaleProvider.tsx';

interface HeaderNavProps {
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
  activeTab: 'discovery' | 'tests' | 'chats' | 'safety' | 'monetization';
  setActiveTab: (tab: 'discovery' | 'tests' | 'chats' | 'safety' | 'monetization') => void;
  unreadChatsCount: number;
}

export const HeaderNav: React.FC<HeaderNavProps> = ({
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
  activeTab,
  setActiveTab,
  unreadChatsCount
}) => {
  const { t, requestedLocale, setLocale } = useLocale();
  return (
    <header className="sticky top-0 z-40 w-full bg-stone-950/80 backdrop-blur-2xl border-b border-white/5 px-2.5 sm:px-4 py-2">
      <div className="max-w-xl sm:max-w-4xl mx-auto flex items-center justify-between gap-1.5 sm:gap-3">
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
        <nav className="hidden sm:flex items-center gap-1 bg-stone-900/90 p-1 rounded-full border border-white/5">
          <button
            onClick={() => setActiveTab('discovery')}
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
            onClick={() => setActiveTab('chats')}
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
          <label className="sr-only" htmlFor="app-language">{t('language')}</label>
          <select
            id="app-language"
            value={requestedLocale}
            onChange={event => setLocale(event.target.value)}
            aria-label={t('language')}
            title={t('language')}
            className="max-w-[74px] sm:max-w-[124px] rounded-full border border-white/10 bg-stone-900 px-1.5 py-1.5 text-[10px] sm:text-xs text-stone-200"
          >
            {LANGUAGE_OPTIONS.map(option => (
              <option key={option.code} value={option.code}>{option.code === 'auto' ? t('autoLanguage') : option.nativeName}</option>
            ))}
          </select>
          {/* Binary Role Switcher */}
          <button
            onClick={onToggleGender}
            className={`flex items-center gap-1 px-2 py-1 rounded-full border text-[11px] font-semibold transition-all shrink-0 ${
              currentGender === 'female'
                ? 'bg-rose-950/40 border-rose-500/40 text-rose-200'
                : 'bg-blue-950/40 border-blue-500/40 text-blue-200'
            }`}
            title="Сменить анкету: Женщина ♀ (Lady VIP) или Мужчина ♂ (100% Free)"
          >
            <span className={`w-1.5 h-1.5 rounded-full ${currentGender === 'female' ? 'bg-rose-500' : 'bg-blue-400'}`}></span>
            <span>{currentGender === 'female' ? 'Анна ♀' : 'Алексей ♂'}</span>
          </button>

          {/* Filter button */}
          <button
            onClick={onOpenFilters}
            className="p-1.5 rounded-full bg-stone-900 border border-white/10 text-stone-300 hover:text-white hover:border-rose-500/40 transition-colors shrink-0"
            title={t('filters')}
            aria-label={t('filters')}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
          </button>

          {/* Lady Premium is only offered in the female demo persona. */}
          {currentGender === 'female' && (
            <button
              onClick={onOpenPremiumModal}
              className={`flex items-center gap-1 px-2 sm:px-2.5 py-1 rounded-full text-[11px] font-black transition-all shadow-md shrink-0 ${
                isLadyPremium
                  ? 'bg-gradient-to-r from-amber-400 to-amber-500 text-stone-950 ring-1 ring-amber-300'
                  : 'bg-gradient-to-r from-rose-600 to-red-600 text-white hover:brightness-110'
              }`}
            >
              <Crown className="w-3 h-3 fill-current shrink-0" />
              <span>{isLadyPremium ? 'VIP' : 'Lady VIP'}</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
