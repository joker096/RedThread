import React, { useEffect, useRef } from 'react';
import { useLocale } from '../i18n/LocaleProvider.tsx';
import { 
  X, 
  SlidersHorizontal,
  MapPin, 
  ShieldCheck, 
  Sparkles,
  Check
} from 'lucide-react';

interface FilterDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  minCompatibility: number;
  setMinCompatibility: (val: number) => void;
  onlyVerified: boolean;
  setOnlyVerified: (val: boolean) => void;
  selectedCountry: string;
  setSelectedCountry: (val: string) => void;
  selectedCity: string;
  setSelectedCity: (val: string) => void;
  intentFilter: string;
  setIntentFilter: (val: string) => void;
  minAge: number;
  setMinAge: (val: number) => void;
  maxAge: number;
  setMaxAge: (val: number) => void;
  onApply: () => void;
  onReset: () => void;
}

export const FilterDrawer: React.FC<FilterDrawerProps> = ({
  isOpen,
  onClose,
  minCompatibility,
  setMinCompatibility,
  onlyVerified,
  setOnlyVerified,
  selectedCountry,
  setSelectedCountry,
  selectedCity,
  setSelectedCity,
  intentFilter,
  setIntentFilter,
  minAge,
  setMinAge,
  maxAge,
  setMaxAge,
  onApply,
  onReset
}) => {
  const { t } = useLocale();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== 'Tab') return;
      const dialog = closeButtonRef.current?.closest('[role="dialog"]');
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ));
      if (!focusable.length) { event.preventDefault(); return; }
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [isOpen]);
  if (!isOpen) return null;

  return (
    <div className="vow-filter-backdrop fixed inset-0 z-50 flex items-end justify-center bg-stone-950/80 p-2 backdrop-blur-sm animate-in fade-in duration-200 sm:items-center sm:p-4" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="discovery-filter-title" aria-describedby="discovery-filter-description" className="relative max-h-[calc(100dvh-1rem)] w-full max-w-md overflow-y-auto overscroll-contain rounded-t-3xl border border-rose-900/40 bg-stone-900 p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] text-start shadow-2xl sm:max-h-[min(90dvh,52rem)] sm:rounded-3xl sm:p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-5 h-5 text-rose-500" />
            <h3 id="discovery-filter-title" className="font-heading text-lg font-bold text-white">{t('filterDialogTitle')}</h3>
          </div>
          <button
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
            className="vow-motion-button flex min-h-11 min-w-11 items-center justify-center rounded-full bg-stone-800 text-stone-300 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"
            aria-label={t('closeFilterDialog')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p id="discovery-filter-description" className="text-xs text-stone-400 mb-5">
          {t('filterDialogDescription')}
        </p>

        <div className="space-y-4 text-xs mb-6">
          {/* Minimum Compatibility Threshold */}
          <div>
            <div className="flex justify-between text-stone-300 mb-1.5">
              <span className="font-medium flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-rose-400" />
                <span>{t('minimumCompatibility')}</span>
              </span>
              <span className="font-bold text-rose-400 text-sm">{minCompatibility}%+</span>
            </div>
            <input
              type="range"
              min="50"
              max="95"
              step="5"
              value={minCompatibility}
              aria-label={t('minimumCompatibility')}
              aria-valuetext={`${minCompatibility}%`}
              onChange={e => setMinCompatibility(Number(e.target.value))}
              className="w-full cursor-pointer accent-rose-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-rose-300"
            />
            <div className="flex justify-between text-[10px] text-stone-500 mt-1">
              <span>{t('compatibilityAll')}</span>
              <span>{t('compatibilityIdeal')}</span>
            </div>
          </div>

          {/* Country and city location search */}
          <div className="space-y-3 rounded-2xl border border-white/5 bg-stone-950/50 p-3">
            <div className="flex items-center gap-2 text-white font-semibold">
              <MapPin className="w-4 h-4 text-rose-400" />
              <span>{t('searchLocation')}</span>
            </div>
            <div>
              <label className="block text-stone-300 font-medium mb-1.5" htmlFor="discovery-country">{t('countryLabel')}</label>
              <input
                id="discovery-country"
                type="text"
                value={selectedCountry === 'all' ? '' : selectedCountry}
                onChange={e => setSelectedCountry(e.target.value.trimStart() || 'all')}
                placeholder={t('countryPlaceholder')}
                autoComplete="country-name"
                className="w-full rounded-xl border border-white/10 bg-stone-950 p-2.5 text-xs text-white placeholder:text-stone-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"
              />
            </div>
            <div>
              <label className="block text-stone-300 font-medium mb-1.5" htmlFor="discovery-city">{t('cityLabel')}</label>
              <input id="discovery-city" type="text" value={selectedCity === 'all' ? '' : selectedCity} onChange={e => setSelectedCity(e.target.value.trimStart() || 'all')} placeholder={t('cityPlaceholder')} autoComplete="address-level2" className="w-full bg-stone-950 border border-white/10 rounded-xl p-2.5 text-white text-xs placeholder:text-stone-600" />
              <p className="text-[10px] text-stone-500 mt-1">{t('locationAnyCityHelp')}</p>
            </div>
            {(selectedCountry !== 'all' || selectedCity !== 'all') && (
              <button type="button" onClick={() => { setSelectedCountry('all'); setSelectedCity('all'); }} className="min-h-11 rounded-lg px-2 text-[11px] text-rose-300 underline underline-offset-2 hover:text-rose-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300">{t('clearLocation')}</button>
            )}
          </div>

          <div className="rounded-2xl border border-white/5 bg-stone-950/50 p-3">
            <div className="mb-2 flex items-center gap-2 text-white font-semibold">
              <SlidersHorizontal className="w-4 h-4 text-rose-400" />
              <span>{t('ageRangeTitle')}</span>
            </div>
            <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2">
              <div>
                <label className="mb-1 block text-stone-300" htmlFor="discovery-min-age">{t('ageFrom')}</label>
                <input id="discovery-min-age" type="number" min="18" max={maxAge} value={minAge} onChange={e => setMinAge(Math.min(maxAge, Math.max(18, Number(e.target.value) || 18)))} className="w-full rounded-xl border border-white/10 bg-stone-950 p-2.5 text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300" />
              </div>
              <div>
                <label className="mb-1 block text-stone-300" htmlFor="discovery-max-age">{t('ageTo')}</label>
                <input id="discovery-max-age" type="number" min={minAge} max="120" value={maxAge} onChange={e => setMaxAge(Math.max(minAge, Math.min(120, Number(e.target.value) || minAge)))} className="w-full rounded-xl border border-white/10 bg-stone-950 p-2.5 text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300" />
              </div>
            </div>
            <p className="mt-1 text-[10px] text-stone-500">{t('adultRangeHelp')}</p>
          </div>

          {/* Relationship Goal */}
          <div>
            <span className="mb-1.5 block text-stone-300 font-medium">{t('relationshipGoal')}</span>
            <div role="group" aria-label={t('relationshipGoal')} data-testid="relationship-intent-options" className="space-y-1.5">
              {[
                { id: 'all', label: t('any') }, 
                { id: 'marriage_family', label: t('marriageFamily') }, 
                { id: 'serious_relationship', label: t('seriousRelationship') }
              ].map(item => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setIntentFilter(item.id)}
                  aria-pressed={intentFilter === item.id}
                  className={`w-full text-start p-2.5 rounded-xl border transition-all text-xs flex items-center justify-between focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300 ${
                    intentFilter === item.id
                      ? 'bg-rose-950/60 border-rose-500 text-white font-semibold'
                      : 'bg-stone-950/40 border-white/5 text-stone-400 hover:text-white'
                  }`}
                >
                  <span>{item.label}</span>
                  {intentFilter === item.id && <Check className="w-3.5 h-3.5 text-rose-400" />}
                </button>
              ))}
            </div>
          </div>

          {/* Demo-only filter; a label is not proof of identity. */}
          <div className="p-3 rounded-2xl bg-stone-950 border border-emerald-500/20 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <div>
                <span className="text-white font-medium">{t('verifiedFilterTitle')}</span>
                <p className="text-[10px] leading-relaxed text-stone-400">{t('verifiedFilterDescription')}</p>
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={onlyVerified}
              aria-label={t('verifiedFilterTitle')}
              onClick={() => setOnlyVerified(!onlyVerified)}
              className={`relative min-h-11 min-w-11 rounded-full p-0.5 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300 ${
                onlyVerified ? 'bg-emerald-500' : 'bg-stone-800'
              }`}
            >
              <div
                className={`w-5 h-5 rounded-full bg-white transition-transform ${
                  onlyVerified ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => {
              onReset();
              onClose();
            }}
            type="button"
            className="vow-motion-button min-h-11 flex-1 rounded-xl bg-stone-800 py-3 text-xs font-semibold text-stone-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"
          >
            {t('resetFilters')}
          </button>
          <button
            onClick={() => {
              onApply();
              onClose();
            }}
            type="button"
            className="vow-motion-button min-h-11 flex-1 rounded-xl bg-rose-600 py-3 text-xs font-bold text-white shadow-lg shadow-rose-950 hover:bg-rose-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"
          >
            {t('applyFilters')}
          </button>
        </div>
      </div>
    </div>
  );
};
