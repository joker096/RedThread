import React from 'react';
import { 
  X, 
  SlidersHorizontal, 
  ShieldCheck, 
  Heart, 
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
  selectedCity: string;
  setSelectedCity: (val: string) => void;
  intentFilter: string;
  setIntentFilter: (val: string) => void;
  onApply: () => void;
}

export const FilterDrawer: React.FC<FilterDrawerProps> = ({
  isOpen,
  onClose,
  minCompatibility,
  setMinCompatibility,
  onlyVerified,
  setOnlyVerified,
  selectedCity,
  setSelectedCity,
  intentFilter,
  setIntentFilter,
  onApply
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-stone-950/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-md rounded-3xl bg-stone-900 border border-rose-900/40 p-5 sm:p-6 shadow-2xl text-left">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-5 h-5 text-rose-500" />
            <h3 className="font-heading text-lg font-bold text-white">Фильтры совместимости</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full bg-stone-800 text-stone-400 hover:text-white"
            aria-label="Закрыть"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-stone-400 mb-5">
          Точный отбор по ценностям, чтобы не тратить время на неподходящие переписки
        </p>

        <div className="space-y-4 text-xs mb-6">
          {/* Minimum Compatibility Threshold */}
          <div>
            <div className="flex justify-between text-stone-300 mb-1.5">
              <span className="font-medium flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-rose-400" />
                <span>Минимальный индекс совместимости:</span>
              </span>
              <span className="font-bold text-rose-400 text-sm">{minCompatibility}%+</span>
            </div>
            <input
              type="range"
              min="50"
              max="95"
              step="5"
              value={minCompatibility}
              onChange={e => setMinCompatibility(Number(e.target.value))}
              className="w-full accent-rose-600 cursor-pointer"
            />
            <div className="flex justify-between text-[10px] text-stone-500 mt-1">
              <span>От 50% (Все)</span>
              <span>От 85% (Идеальная пара)</span>
            </div>
          </div>

          {/* City Selection */}
          <div>
            <label className="block text-stone-300 font-medium mb-1.5">Город поиска:</label>
            <select
              value={selectedCity}
              onChange={e => setSelectedCity(e.target.value)}
              className="w-full bg-stone-950 border border-white/10 rounded-xl p-2.5 text-white text-xs"
            >
              <option value="all">Все города РФ</option>
              <option value="Москва">Москва</option>
              <option value="Санкт-Петербург">Санкт-Петербург</option>
              <option value="Казань">Казань</option>
            </select>
          </div>

          {/* Relationship Goal */}
          <div>
            <label className="block text-stone-300 font-medium mb-1.5">Главная цель:</label>
            <div className="space-y-1.5">
              {[
                { id: 'all', label: 'Любая серьезная цель' },
                { id: 'marriage_family', label: '💍 Только создание семьи и брак' },
                { id: 'serious_relationship', label: '❤️ Серьезные долгосрочные отношения' }
              ].map(item => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setIntentFilter(item.id)}
                  className={`w-full text-left p-2.5 rounded-xl border transition-all text-xs flex items-center justify-between ${
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

          {/* Only 100% verified authentic toggle */}
          <div className="p-3 rounded-2xl bg-stone-950 border border-emerald-500/20 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <div>
                <span className="text-white font-medium">Только проверенные без ботов</span>
                <p className="text-[10px] text-stone-400">С подтвержденным селфи живого человека</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOnlyVerified(!onlyVerified)}
              className={`w-11 h-6 rounded-full transition-colors relative p-0.5 ${
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
            onClick={onClose}
            className="flex-1 py-3 rounded-xl bg-stone-800 text-stone-300 font-semibold text-xs"
          >
            Сбросить
          </button>
          <button
            onClick={() => {
              onApply();
              onClose();
            }}
            className="flex-1 py-3 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs shadow-lg shadow-rose-950"
          >
            Применить фильтры
          </button>
        </div>
      </div>
    </div>
  );
};
