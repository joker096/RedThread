import React, { useEffect, useRef, useState } from 'react';
import { 
  Heart, 
  X, 
  Sparkles, 
  ShieldCheck, 
  Volume2, 
  VolumeX, 
  MapPin, 
  Briefcase, 
  CheckCircle2, 
  ChevronRight, 
  Award, 
  Zap, 
  Brain, 
  ExternalLink, 
  Gift,
  Star
} from 'lucide-react';
import type { UserProfile, CrucialAnswers } from '../types/index.ts';
import { calculateCompatibility } from '../utils/compatibility.ts';
import { getSwipeActionFromDelta } from '../utils/swipe.ts';

interface RadarDiscoveryProps {
  profiles: UserProfile[];
  myAnswers: CrucialAnswers;
  myIntent: string;
  myInterests: string[];
  isLadyPremium: boolean;
  onLike: (profile: UserProfile) => void;
  onSuperLike: (profile: UserProfile) => void;
  onPass: (profile: UserProfile) => void;
  onOpenCompatibilityMatrix: (profile: UserProfile) => void;
  onInspectBotSafety: (profile: UserProfile) => void;
  onOpenLadyPremium: () => void;
  onOpenAdManager: () => void;
  onOpenFilters: () => void;
  onAdClicked: () => void;
}

export const RadarDiscovery: React.FC<RadarDiscoveryProps> = ({
  profiles,
  myAnswers,
  myIntent,
  myInterests,
  isLadyPremium,
  onLike,
  onSuperLike,
  onPass,
  onOpenCompatibilityMatrix,
  onInspectBotSafety,
  onOpenLadyPremium,
  onOpenAdManager,
  onOpenFilters,
  onAdClicked
}) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [photoIndex, setPhotoIndex] = useState(0);
  const [activePsychCardIndex, setActivePsychCardIndex] = useState(0);
  const [history, setHistory] = useState<number[]>([]);
  const touchStartX = useRef<number | null>(null);

  const currentProfile = profiles[currentIndex];

  // Keep the discovery card in range when filters or the candidate pool change.
  useEffect(() => {
    // Reset only when the candidate pool is empty. Reaching the end must not
    // silently loop back to profiles the user has already reviewed.
    if (profiles.length === 0) {
      setCurrentIndex(0);
      setHistory([]);
      setPhotoIndex(0);
      setActivePsychCardIndex(0);
      setIsPlayingAudio(false);
    } else if (currentIndex > profiles.length) {
      setCurrentIndex(profiles.length);
    }
  }, [profiles.length, currentIndex]);

  const handleNext = () => {
    if (profiles.length > 0) setHistory(previous => [...previous, currentIndex].slice(-50));
    setIsPlayingAudio(false);
    setPhotoIndex(0);
    setActivePsychCardIndex(0);
    setCurrentIndex(prev => Math.min(prev + 1, profiles.length));
  };

  const handleLikeCurrent = () => {
    if (currentProfile) {
      onLike(currentProfile);
      handleNext();
    }
  };

  const handleSuperLikeCurrent = () => {
    if (currentProfile) {
      onSuperLike(currentProfile);
      handleNext();
    }
  };

  const handlePassCurrent = () => {
    if (currentProfile) {
      onPass(currentProfile);
      handleNext();
    }
  };

  const handleUndo = () => {
    if (history.length === 0) return;
    const previousIndex = history[history.length - 1];
    setHistory(previous => previous.slice(0, -1));
    setCurrentIndex(previousIndex);
    setPhotoIndex(0);
    setActivePsychCardIndex(0);
    setIsPlayingAudio(false);
  };

  const handleTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    touchStartX.current = event.touches[0]?.clientX ?? null;
  };

  const handleTouchEnd = (event: React.TouchEvent<HTMLDivElement>) => {
    const start = touchStartX.current;
    touchStartX.current = null;
    const end = event.changedTouches[0]?.clientX;
    if (start === null || end === undefined) return;
    const action = getSwipeActionFromDelta(end - start);
    if (currentProfile?.isSponsorAd) {
      if (action !== 'none') handlePassCurrent();
      return;
    }
    if (action === 'like') handleLikeCurrent();
    if (action === 'pass') handlePassCurrent();
  };

  const toggleAudio = () => {
    setIsPlayingAudio(!isPlayingAudio);
  };

  if (!currentProfile) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center min-h-[420px] w-full">
        <div className="w-16 h-16 rounded-full bg-rose-950/60 flex items-center justify-center text-rose-400 mb-4 border border-rose-800/40">
          <Heart className="w-8 h-8" />
        </div>
        <h3 className="font-heading text-lg font-bold text-white mb-2">
          {profiles.length > 0 && currentIndex >= profiles.length ? 'Вы просмотрели все анкеты' : 'Подходящих анкет пока нет'}
        </h3>
        <p className="text-xs text-stone-400 max-w-sm mb-6 leading-relaxed">
          {profiles.length > 0 && currentIndex >= profiles.length
            ? 'Повторный показ не запускается автоматически. Можно начать просмотр заново или изменить фильтры.'
            : 'Попробуйте изменить страну, город или другие фильтры. В деморежиме доступны только демонстрационные анкеты.'}
        </p>
        {profiles.length > 0 && currentIndex >= profiles.length && (
          <button
            onClick={() => { setHistory([]); setCurrentIndex(0); setPhotoIndex(0); setActivePsychCardIndex(0); setIsPlayingAudio(false); }}
            className="mb-3 px-6 py-2.5 rounded-full bg-emerald-600 hover:bg-emerald-500 font-bold text-white text-xs"
          >
            Начать просмотр заново
          </button>
        )}
        <button
          onClick={onOpenFilters}
          className="px-6 py-2.5 rounded-full bg-rose-600 hover:bg-rose-500 font-bold text-white shadow-lg shadow-rose-950 text-xs"
        >
          Изменить фильтры
        </button>
      </div>
    );
  }

  const compatibility = calculateCompatibility(myAnswers, myIntent, myInterests, currentProfile);

  return (
    <div className="w-full max-w-sm sm:max-w-md mx-auto flex flex-col items-center select-none">
      {/* Top Micro-Bar: Compatibility score and rewarded demo */}
      <div className="w-full flex items-center justify-between px-2 mb-2 text-xs">
        <div className="flex items-center gap-1.5 text-stone-300">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
          <span className="text-[11px] font-semibold text-stone-400">
            Совместимость: <strong className="text-white">{compatibility.overallScore}%</strong>
          </span>
        </div>

        {/* Adaptive Rewarded Ad Pill */}
        {!isLadyPremium && (
          <button
            onClick={onOpenAdManager}
            className="flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[10px] font-bold hover:bg-amber-500/25 transition-all"
            title="Посмотреть ролик спонсора и получить суперлайки"
          >
            <Gift className="w-3 h-3 text-amber-400" />
            <span>Бонус за ролик</span>
          </button>
        )}
      </div>

      {/* Main Full-Bleed Card Container */}
      <div onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd} className="w-full relative rounded-3xl overflow-hidden bg-stone-900 border border-white/10 shadow-2xl transition-all">
        {currentProfile.isSponsorAd ? (
          /* 100% ADAPTIVE NATIVE SPONSOR AD CARD */
          <div className="flex flex-col w-full text-left">
            <div className="relative w-full h-56 sm:h-64 overflow-hidden bg-stone-950">
              <img
                src={currentProfile.photos[0]}
                alt={currentProfile.name}
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-stone-950 via-stone-950/40 to-transparent"></div>

              {/* Sponsor Adaptive Tag */}
              <div className="absolute top-3 left-3 bg-amber-500 text-stone-950 text-[10px] sm:text-xs font-black px-2.5 py-0.5 sm:px-3 sm:py-1 rounded-full uppercase tracking-wider shadow-lg flex items-center gap-1">
                <Award className="w-3.5 h-3.5 fill-stone-950" />
                <span>Спонсор первого свидания</span>
              </div>
            </div>

            <div className="p-4 sm:p-5 -mt-6 relative z-10 bg-gradient-to-t from-stone-950 via-stone-950 to-transparent pt-6">
              <div className="flex items-center justify-between mb-1">
                <h3 className="text-xl sm:text-2xl font-heading font-black text-white">
                  {currentProfile.name}
                </h3>
                <span className="text-[11px] font-bold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-md border border-amber-500/20">
                  Партнер
                </span>
              </div>

              <p className="text-xs text-rose-400 font-medium mb-2">
                {currentProfile.city}
              </p>

              <p className="text-xs text-stone-300 leading-relaxed mb-4">
                {currentProfile.bio}
              </p>

              {/* Responsive Promo Offer Card */}
              <div className="p-3 rounded-2xl bg-rose-950/40 border border-rose-800/40 mb-4">
                <div className="text-xs font-bold text-white mb-0.5">{currentProfile.sponsorTitle}</div>
                <div className="text-[11px] text-rose-300/90 leading-tight">{currentProfile.sponsorDescription}</div>
              </div>

              {/* Responsive CTA Buttons */}
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={handlePassCurrent}
                  className="flex-1 py-2.5 sm:py-3 rounded-2xl bg-stone-800 hover:bg-stone-700 font-bold text-stone-300 text-xs transition-colors"
                >
                  Пропустить
                </button>
                <button
                  onClick={() => {
                    onAdClicked();
                    window.open(currentProfile.sponsorUrl, '_blank');
                  }}
                  className="flex-2 py-2.5 sm:py-3 rounded-2xl bg-gradient-to-r from-amber-500 to-rose-600 hover:from-amber-400 hover:to-rose-500 font-black text-stone-950 text-xs flex items-center justify-center gap-1.5 shadow-lg shadow-rose-950/40 transition-all"
                >
                  <span>{currentProfile.sponsorCta}</span>
                  <ExternalLink className="w-3.5 h-3.5 stroke-[2.5]" />
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* Profile card */
          <div className="flex flex-col w-full text-left">
            {/* Top Photo Frame */}
            <div className="relative h-72 sm:h-80 w-full overflow-hidden bg-stone-950 select-none">
              <img
                src={currentProfile.photos[photoIndex] || currentProfile.avatar}
                alt={currentProfile.name}
                className="w-full h-full object-cover transition-transform duration-500"
              />

              {/* Photo Tap Zones */}
              <div className="absolute inset-0 flex">
                <div
                  className="w-1/2 h-full cursor-pointer"
                  onClick={() => setPhotoIndex(prev => Math.max(0, prev - 1))}
                  title="Предыдущее фото"
                />
                <div
                  className="w-1/2 h-full cursor-pointer"
                  onClick={() => setPhotoIndex(prev => Math.min(currentProfile.photos.length - 1, prev + 1))}
                  title="Следующее фото"
                />
              </div>

              {/* Stories / Photo Dots */}
              {currentProfile.photos.length > 1 && (
                <div className="absolute top-2.5 left-3 right-3 flex gap-1 z-20">
                  {currentProfile.photos.map((_, idx) => (
                    <div
                      key={idx}
                      className={`h-1 flex-1 rounded-full transition-all ${
                        idx === photoIndex ? 'bg-white shadow-md' : 'bg-white/30'
                      }`}
                    />
                  ))}
                </div>
              )}

              {/* Compatibility badge (Top Left) */}
              <div
                onClick={() => onOpenCompatibilityMatrix(currentProfile)}
                className="absolute top-6 left-3 z-20 cursor-pointer bg-stone-950/75 hover:bg-stone-950/90 border border-white/15 text-white px-2.5 py-1 rounded-2xl backdrop-blur-xl flex items-center gap-2 shadow-lg transition-all"
              >
                <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-rose-600 to-amber-400 p-0.5 flex items-center justify-center font-black text-xs text-white">
                  <div className="w-full h-full rounded-full bg-stone-950 flex items-center justify-center">
                    <span className="text-[10px] font-black">{compatibility.overallScore}%</span>
                  </div>
                </div>
                <div>
                  <div className="text-[9px] text-stone-300 font-semibold flex items-center gap-0.5">
                    <span>Совместимость</span>
                    <ChevronRight className="w-2.5 h-2.5 text-rose-400" />
                  </div>
                  <div className="text-[10px] font-bold text-emerald-400">
                    {compatibility.overallScore >= 85 ? 'Высокая химия' : 'Хороший коннект'}
                  </div>
                </div>
              </div>

              {/* Verified Anti-Bot Badge (Top Right) */}
              <div
                onClick={() => onInspectBotSafety(currentProfile)}
                className="absolute top-6 right-3 z-20 cursor-pointer bg-stone-950/75 hover:bg-stone-950/90 border border-emerald-500/30 text-emerald-400 px-2.5 py-1 rounded-2xl backdrop-blur-xl flex items-center gap-1 shadow-lg transition-colors"
                title="Верификация 3D-Liveness"
              >
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-[10px] font-bold text-white">
                  {currentProfile.verification.isVerified ? 'Проверен (демо)' : 'Не проверен'}
                </span>
              </div>

              {/* Voice Intro Floating Button */}
              {currentProfile.voiceIntroSeconds && (
                <button
                  onClick={toggleAudio}
                  className={`absolute bottom-3 left-3 z-20 flex items-center gap-1.5 px-2.5 py-1 rounded-full backdrop-blur-xl border text-[11px] font-semibold transition-all ${
                    isPlayingAudio
                      ? 'bg-rose-600 text-white border-rose-400 red-glow'
                      : 'bg-stone-950/75 hover:bg-stone-900 text-stone-200 border-white/20'
                  }`}
                >
                  {isPlayingAudio ? (
                    <>
                      <VolumeX className="w-3 h-3 animate-pulse" />
                      <span>Голос ({currentProfile.voiceIntroSeconds} с)</span>
                    </>
                  ) : (
                    <>
                      <Volume2 className="w-3 h-3 text-rose-400" />
                      <span>Голос ({currentProfile.voiceIntroSeconds} с)</span>
                    </>
                  )}
                </button>
              )}

              {/* Vignette Shadow */}
              <div className="absolute inset-0 bg-gradient-to-t from-stone-950 via-stone-950/20 to-transparent pointer-events-none"></div>
            </div>

            {/* Profile Info & Psychological Cards */}
            <div className="p-3.5 sm:p-4 -mt-5 relative z-10 bg-gradient-to-t from-stone-950 via-stone-950 to-transparent pt-5">
              {/* Name, Age, Location */}
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-baseline gap-2">
                  <h2 className="text-xl sm:text-2xl font-heading font-black text-white tracking-tight">
                    {currentProfile.name}
                  </h2>
                  <span className="text-lg font-medium text-stone-400">{currentProfile.age}</span>
                  <CheckCircle2 className="w-4 h-4 text-rose-500 fill-rose-500/20" />
                </div>
                <span className="text-[11px] text-stone-400 flex items-center gap-1 font-medium">
                  <MapPin className="w-3 h-3 text-rose-500" />
                  {currentProfile.city}
                </span>
              </div>

              {/* Occupation & Height */}
              <div className="flex items-center gap-2 text-[11px] text-stone-300 mb-2.5">
                <Briefcase className="w-3 h-3 text-stone-400" />
                <span className="truncate">{currentProfile.occupation}</span>
                <span>•</span>
                <span>{currentProfile.height} см</span>
              </div>

              {/* Psychology profile tags */}
              <div className="flex flex-wrap gap-1.5 mb-2.5">
                {currentProfile.mbti && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/15 border border-rose-500/30 text-rose-300 flex items-center gap-1">
                    <Brain className="w-3 h-3 text-rose-400" />
                    {currentProfile.mbti}
                  </span>
                )}
                {currentProfile.attachmentStyle && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-stone-800 border border-white/10 text-stone-200">
                    {currentProfile.attachmentStyle}
                  </span>
                )}
              </div>

              {/* Bio */}
              <p className="text-[11px] sm:text-xs text-stone-300 leading-relaxed mb-3">
                {currentProfile.bio}
              </p>

              {/* Profile question cards */}
              {currentProfile.psychCards && currentProfile.psychCards.length > 0 && (
                <div className="rounded-2xl bg-stone-900/95 border border-white/10 p-3 mb-3 shadow-inner">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[9px] uppercase font-bold tracking-wider text-rose-400 flex items-center gap-1">
                      <Sparkles className="w-2.5 h-2.5" />
                      Вопрос профиля ({activePsychCardIndex + 1}/{currentProfile.psychCards.length})
                    </span>
                    <div className="flex gap-1">
                      {currentProfile.psychCards.map((_, i) => (
                        <button
                          key={i}
                          onClick={() => setActivePsychCardIndex(i)}
                          className={`w-1.5 h-1.5 rounded-full transition-all ${
                            i === activePsychCardIndex ? 'bg-rose-500 w-3' : 'bg-stone-700'
                          }`}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="text-xs">
                    <p className="font-semibold text-white mb-0.5 text-[11px]">
                      {currentProfile.psychCards[activePsychCardIndex].question}
                    </p>
                    <p className="text-stone-300 text-[10px] italic">
                      «{currentProfile.psychCards[activePsychCardIndex].answer}»
                    </p>
                    <div className="mt-1.5 flex items-center justify-between text-[9px]">
                      <span className="text-emerald-400 font-bold flex items-center gap-1">
                        <CheckCircle2 className="w-2.5 h-2.5" />
                        Резонанс: {currentProfile.psychCards[activePsychCardIndex].matchBonus}%
                      </span>
                      <button
                        onClick={() => setActivePsychCardIndex((activePsychCardIndex + 1) % (currentProfile.psychCards?.length || 1))}
                        className="text-stone-400 hover:text-white underline"
                      >
                        Далее →
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Green & Red Flag Micro-Pills */}
              <div className="space-y-1 mb-3.5 text-[10px]">
                <div className="flex flex-wrap gap-1">
                  <span className="px-2 py-0.5 rounded-md bg-emerald-950/60 border border-emerald-500/30 text-emerald-300 font-medium">
                    🟢 {currentProfile.crucialAnswers.marriage_and_kids}
                  </span>
                  <span className="px-2 py-0.5 rounded-md bg-emerald-950/60 border border-emerald-500/30 text-emerald-300 font-medium">
                    🟢 {currentProfile.crucialAnswers.finances}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  <span className="px-2 py-0.5 rounded-md bg-rose-950/50 border border-rose-500/20 text-rose-300 font-medium">
                    🔴 Без пустых переписок: встреча в течение 72 ч
                  </span>
                </div>
              </div>

              {/* Floating Circular Action Buttons (Profile action buttons) */}
              <div className="flex items-center justify-center gap-3 sm:gap-4 pt-1">
                <button
                  onClick={handleUndo}
                  disabled={history.length === 0}
                  className="w-10 h-10 rounded-full bg-stone-900 text-stone-300 disabled:text-stone-700 disabled:opacity-50 hover:bg-stone-800 flex items-center justify-center border border-white/10 transition-all"
                  title="Отменить последнее действие"
                  aria-label="Отменить последнее действие"
                >
                  <span className="text-lg leading-none">↶</span>
                </button>
                {/* 1. Pass (Circle) */}
                <button
                  onClick={handlePassCurrent}
                  className="w-12 h-12 rounded-full bg-stone-900 hover:bg-stone-800 text-stone-400 hover:text-white flex items-center justify-center border border-white/10 transition-all hover:scale-110 active:scale-95 shadow-lg"
                  title="Пропустить"
                  aria-label="Пропустить"
                >
                  <X className="w-5 h-5 stroke-[2.5]" />
                </button>

                {/* 2. Compatibility Test Matrix (Compatibility details) */}
                <button
                  onClick={() => onOpenCompatibilityMatrix(currentProfile)}
                  className="w-12 h-12 rounded-full bg-stone-900 hover:bg-rose-950/80 text-rose-400 flex items-center justify-center border border-rose-600/40 transition-all hover:scale-110 active:scale-95 shadow-lg shadow-rose-950/30"
                  title="Психологический тест и Матрица совместимости"
                  aria-label="Матрица совместимости"
                >
                  <Zap className="w-5 h-5 fill-rose-500 stroke-rose-400" />
                </button>

                {/* 3. Superlike (Golden Star Circle) */}
                <button
                  onClick={handleSuperLikeCurrent}
                  className="w-12 h-12 rounded-full bg-gradient-to-tr from-amber-500 to-amber-600 text-stone-950 flex items-center justify-center font-bold shadow-lg shadow-amber-950/50 transition-all hover:scale-110 active:scale-95"
                  title="Супер-симпатия"
                  aria-label="Супер-симпатия"
                >
                  <Star className="w-5 h-5 fill-stone-950 stroke-none" />
                </button>

                {/* 4. Like / Connect (Glowing Scarlet Heart Circle) */}
                <button
                  onClick={handleLikeCurrent}
                  className="w-14 h-14 rounded-full bg-gradient-to-r from-rose-600 via-red-600 to-rose-700 hover:from-rose-500 hover:to-red-500 text-white flex items-center justify-center red-glow transition-all hover:scale-110 active:scale-95 shadow-xl shadow-rose-950/60"
                  title="Симпатия и приглашение"
                  aria-label="Симпатия"
                >
                  <Heart className="w-7 h-7 fill-white stroke-none" />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
