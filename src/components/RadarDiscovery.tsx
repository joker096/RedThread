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
  ChevronDown,
  ChevronUp,
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
import { useLocale } from '../i18n/LocaleProvider.tsx';

interface RadarDiscoveryProps {
  profiles: UserProfile[];
  myAnswers: CrucialAnswers;
  myIntent: string;
  myInterests: string[];
  isLadyPremium: boolean;
  onLike: (profile: UserProfile) => void;
  onSuperLike: (profile: UserProfile) => boolean | void;
  onUndoAction: (
    profile: UserProfile,
    action: 'like' | 'superLike',
    previousState: { likedByMe: boolean; superLikedByMe: boolean }
  ) => boolean | void;
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
  onUndoAction,
  onPass,
  onOpenCompatibilityMatrix,
  onInspectBotSafety,
  onOpenLadyPremium,
  onOpenAdManager,
  onOpenFilters,
  onAdClicked
}) => {
  const { t } = useLocale();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [photoIndex, setPhotoIndex] = useState(0);
  const [photoCollapsed, setPhotoCollapsed] = useState(false);
  const [activePsychCardIndex, setActivePsychCardIndex] = useState(0);
  const [history, setHistory] = useState<Array<{
    index: number;
    profileId: string;
    action: 'like' | 'superLike' | 'pass' | 'ad';
    wasLiked: boolean;
    wasSuperLiked: boolean;
  }>>([]);
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  const photoTouchStart = useRef<{ x: number; y: number } | null>(null);
  // A sponsored placement is dismissed for this discovery session after one pass/swipe.
  const dismissedSponsorAds = useRef(new Set<string>());
  // Only configured, server-backed campaigns may produce analytics events.
  // Demo placements deliberately have no campaign ID and are never counted.
  const recordedImpressionCampaigns = useRef(new Set<string>());
  const impressionRequests = useRef(new Map<string, Promise<boolean>>());

  const sendAdEvent = (campaignId: string, eventType: 'impression' | 'click'): Promise<boolean> => {
    if (!campaignId) return Promise.resolve(false);
    let eventId: string;
    try {
      eventId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `vow-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    } catch {
      eventId = `vow-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    return fetch('/api/ads/events', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId, campaignId, eventType })
    }).then(response => response.ok).catch(() => {
      // Analytics must never interrupt discovery or opening the sponsor destination.
      return false;
    });
  };

  const currentProfile = profiles[currentIndex];
  useEffect(() => { setPhotoCollapsed(false); setPhotoIndex(0); photoTouchStart.current = null; }, [currentProfile?.id]);
  const profilePoolSignature = profiles.map(profile => profile.id).join('\u001f');
  const previousPoolSignature = useRef(profilePoolSignature);

  useEffect(() => {
    const campaignId = currentProfile?.isSponsorAd ? currentProfile.sponsorCampaignId : undefined;
    if (!campaignId || recordedImpressionCampaigns.current.has(campaignId)) return;
    recordedImpressionCampaigns.current.add(campaignId);
    impressionRequests.current.set(campaignId, sendAdEvent(campaignId, 'impression'));
  }, [currentProfile?.id, currentProfile?.isSponsorAd, currentProfile?.sponsorCampaignId]);

  // A filter change can reorder or replace candidates. Clear navigation history
  // for a changed ID sequence, not for ordinary profile-state updates.
  useEffect(() => {
    if (previousPoolSignature.current !== profilePoolSignature) {
      previousPoolSignature.current = profilePoolSignature;
      setHistory([]);
      setCurrentIndex(0);
      setPhotoIndex(0);
      setActivePsychCardIndex(0);
      setIsPlayingAudio(false);
      return;
    }
    if (profiles[currentIndex]?.isSponsorAd && dismissedSponsorAds.current.has(profiles[currentIndex].id)) {
      setCurrentIndex(previous => Math.min(previous + 1, profiles.length));
      return;
    }
    if (profiles.length === 0) {
      setCurrentIndex(0);
      setHistory([]);
      setPhotoIndex(0);
      setActivePsychCardIndex(0);
      setIsPlayingAudio(false);
    } else if (currentIndex > profiles.length) {
      setCurrentIndex(profiles.length);
    }
  }, [profilePoolSignature, profiles.length, currentIndex]);

  const handleNext = (action: 'like' | 'superLike' | 'pass' | 'ad') => {
    if (currentProfile?.isSponsorAd && action === 'ad') {
      dismissedSponsorAds.current.add(currentProfile.id);
    }
    if (currentProfile) setHistory(previous => [...previous, {
      index: currentIndex,
      profileId: currentProfile.id,
      action,
      wasLiked: Boolean(currentProfile.likedByMe),
      wasSuperLiked: Boolean(currentProfile.superLikedByMe)
    }].slice(-50));
    setIsPlayingAudio(false);
    setPhotoIndex(0);
    setPhotoCollapsed(false);
    setActivePsychCardIndex(0);
    setCurrentIndex(prev => Math.min(prev + 1, profiles.length));
  };

  const handleLikeCurrent = () => {
    if (currentProfile) {
      onLike(currentProfile);
      handleNext('like');
    }
  };

  const handleSuperLikeCurrent = () => {
    if (currentProfile) {
      const accepted = onSuperLike(currentProfile);
      if (accepted === false) return;
      handleNext('superLike');
    }
  };

  const handlePassCurrent = () => {
    if (currentProfile) {
      onPass(currentProfile);
      handleNext(currentProfile.isSponsorAd ? 'ad' : 'pass');
    }
  };

  const handleUndo = () => {
    if (history.length === 0) return;
    const previous = history[history.length - 1];
    const previousProfile = profiles.find(profile => profile.id === previous.profileId);
    if (previousProfile && (previous.action === 'like' || previous.action === 'superLike')) {
      if (onUndoAction(previousProfile, previous.action, {
        likedByMe: previous.wasLiked,
        superLikedByMe: previous.wasSuperLiked
      }) === false) return;
    }
    setHistory(items => items.slice(0, -1));
    setCurrentIndex(previousProfile ? profiles.findIndex(profile => profile.id === previousProfile.id) : previous.index);
    setPhotoIndex(0);
    setActivePsychCardIndex(0);
    setIsPlayingAudio(false);
  };

  const handleTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    // Never interpret a gesture that starts on a control as a card action.
    // This prevents a small finger drag on photo navigation/audio/buttons from
    // accidentally liking or passing a profile on touch devices.
    if ((event.target as HTMLElement).closest('button, input, select, textarea, a, [role="button"]')) {
      touchStartX.current = null;
      touchStartY.current = null;
      return;
    }
    // Leave pinch/zoom gestures to the browser and assistive interaction tools.
    if (event.touches.length !== 1) {
      touchStartX.current = null;
      touchStartY.current = null;
      return;
    }
    touchStartX.current = event.touches[0]?.clientX ?? null;
    touchStartY.current = event.touches[0]?.clientY ?? null;
  };

  const handleTouchEnd = (event: React.TouchEvent<HTMLDivElement>) => {
    const start = touchStartX.current;
    const startY = touchStartY.current;
    touchStartX.current = null;
    touchStartY.current = null;
    const touch = event.changedTouches[0];
    const end = touch?.clientX;
    const endY = touch?.clientY;
    if (start === null || end === undefined) return;
    const deltaX = end - start;
    const deltaY = startY !== null && endY !== undefined ? endY - startY : 0;
    // Vertical gestures reveal profile details; horizontal gestures remain like/pass.
    // Keep buttons usable without turning an accidental finger movement into a card toggle.
    if (startY !== null && endY !== undefined &&
        Math.abs(deltaY) >= 48 && Math.abs(deltaY) > Math.abs(deltaX) * 1.15) {
      if (!(event.target as HTMLElement).closest('button, input, select, textarea, a')) {
        setPhotoCollapsed(deltaY < 0);
      }
      return;
    }
    if (startY !== null && endY !== undefined && Math.abs(deltaX) < Math.abs(deltaY) * 1.15) return;
    const action = getSwipeActionFromDelta(deltaX);
    if (currentProfile?.isSponsorAd) {
      if (action !== 'none') { onPass(currentProfile); handleNext('ad'); }
      return;
    }
    if (action === 'like') handleLikeCurrent();
    if (action === 'pass') handlePassCurrent();
  };

  const handlePhotoNavigationKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    setPhotoIndex(index => {
      if (event.key === 'Home') return 0;
      if (event.key === 'End') return Math.max(0, currentProfile.photos.length - 1);
      if (event.key === 'ArrowLeft') return Math.max(0, index - 1);
      return Math.min(Math.max(0, currentProfile.photos.length - 1), index + 1);
    });
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
          {profiles.length > 0 && currentIndex >= profiles.length ? t('allProfilesViewed') : t('noSuitableProfiles')}
        </h3>
        <p className="text-xs text-stone-400 max-w-sm mb-6 leading-relaxed">
          {profiles.length > 0 && currentIndex >= profiles.length
            ? t('noAutoRepeatHint')
            : t('demoFilterHint')}
        </p>
        {profiles.length > 0 && currentIndex >= profiles.length && (
          <button
            type="button"
            onClick={() => { setHistory([]); setCurrentIndex(0); setPhotoIndex(0); setActivePsychCardIndex(0); setIsPlayingAudio(false); }}
            className="mb-3 inline-flex min-h-11 items-center justify-center px-6 py-2.5 rounded-full bg-emerald-600 hover:bg-emerald-500 font-bold text-white text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"
          >
            {t('restartViewing')}
          </button>
        )}
        <button
          type="button"
          onClick={onOpenFilters}
          className="inline-flex min-h-11 items-center justify-center px-6 py-2.5 rounded-full bg-rose-600 hover:bg-rose-500 font-bold text-white shadow-lg shadow-rose-950 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"
        >
          {t('changeFilters')}
        </button>
      </div>
    );
  }

  const compatibility = calculateCompatibility(myAnswers, myIntent, myInterests, currentProfile);

  return (
    <div className="vow-discovery-stage w-full max-w-sm sm:max-w-md mx-auto flex flex-col items-center select-none">
      {/* Top Micro-Bar: Compatibility score and rewarded demo */}
      <div className="vow-discovery-toolbar w-full flex items-center justify-between px-2 mb-2 text-xs">
        <div className="flex items-center gap-1.5 text-stone-300">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
          <span className="text-[11px] font-semibold text-stone-400">
            {t('compatibility')}: <strong className="text-white">{compatibility.overallScore}%</strong>
          </span>
        </div>

        {/* Adaptive Rewarded Ad Pill */}
        {!isLadyPremium && (
          <button
            type="button"
            onClick={onOpenAdManager}
            className="flex min-h-11 items-center justify-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/15 px-3 py-2 text-[10px] font-bold text-amber-300 transition-all hover:bg-amber-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950"
            title={t('sponsorVideoHelp')}
          >
            <Gift className="w-3 h-3 text-amber-400" />
            <span>{t('bonusVideo')}</span>
          </button>
        )}
      </div>

      {/* Main Full-Bleed Card Container */}
      <div onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd} onTouchCancel={() => { touchStartX.current = null; touchStartY.current = null; }} className="vow-profile-card vow-surface-enter w-full relative rounded-3xl overflow-hidden bg-stone-900 border border-white/10 shadow-2xl transition-all">
        {currentProfile.isSponsorAd ? (
          /* Native sponsored placement: profile-feed styling, clearly disclosed and responsive. */
          <article aria-label={t('sponsorFirstDate')} className="flex w-full flex-col text-left">
            <div className="relative aspect-[4/3] max-h-[min(62vh,420px)] min-h-44 w-full overflow-hidden bg-stone-950 sm:aspect-[16/10]">
              <img
                src={currentProfile.photos[0] || currentProfile.avatar}
                alt={currentProfile.name}
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
              />
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-stone-950/85 via-stone-950/10 to-transparent" />

              <div className="absolute left-3 top-3 inline-flex max-w-[calc(100%-1.5rem)] items-center gap-1.5 rounded-full border border-white/15 bg-stone-950/85 px-2.5 py-1 text-[10px] font-bold text-white shadow-sm backdrop-blur-md sm:left-4 sm:top-4 sm:text-xs">
                <Award aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-amber-300" />
                <span className="truncate">{t('sponsorFirstDate')}</span>
              </div>
            </div>

            <div className="relative z-10 -mt-3 rounded-t-3xl bg-stone-900 px-4 pb-4 pt-4 sm:px-5 sm:pb-5">
              <div className="mb-1 flex min-w-0 flex-wrap items-start justify-between gap-2">
                <h3 className="min-w-0 flex-1 break-words text-lg font-heading font-black leading-tight text-white sm:text-xl">
                  {currentProfile.name}
                </h3>
                <span className="shrink-0 rounded-full border border-amber-400/25 bg-amber-400/10 px-2.5 py-1 text-[10px] font-semibold text-amber-200">
                  {t('partner')}
                </span>
              </div>

              <p className="mb-2 text-xs font-medium text-stone-400">{currentProfile.city}</p>
              <p className="mb-4 break-words text-sm leading-relaxed text-stone-300">
                {currentProfile.bio}
              </p>

              <div className="mb-4 rounded-2xl border border-white/[0.08] bg-stone-950/55 p-3 sm:p-4">
                <div className="mb-1 break-words text-sm font-bold leading-snug text-white">
                  {currentProfile.sponsorTitle}
                </div>
                <div className="break-words text-xs leading-relaxed text-stone-400">
                  {currentProfile.sponsorDescription}
                </div>
              </div>

              <div className="flex flex-col gap-2 min-[360px]:flex-row">
                <button
                  type="button"
                  onClick={handlePassCurrent}
                  className="min-h-11 w-full min-w-0 rounded-xl border border-white/10 bg-stone-800 px-4 py-2.5 text-sm font-semibold text-stone-200 transition-colors hover:bg-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 min-[360px]:w-auto min-[360px]:shrink-0"
                >
                  {t('skip')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!currentProfile.sponsorUrl) return;
                    onAdClicked();
                    window.open(currentProfile.sponsorUrl, '_blank', 'noopener,noreferrer');
                    const campaignId = currentProfile.sponsorCampaignId;
                    if (campaignId) {
                      // Do not block navigation on analytics; ensure the impression request
                      // is attempted first because the server requires it before a click.
                      void (impressionRequests.current.get(campaignId) ?? Promise.resolve(false))
                        .then(impressionRecorded => {
                          if (impressionRecorded) return sendAdEvent(campaignId, 'click');
                          return false;
                        });
                    }
                  }}
                  disabled={!currentProfile.sponsorUrl}
                  className="inline-flex min-h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-rose-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="break-words">{currentProfile.sponsorCta}</span>
                  <ExternalLink aria-hidden="true" className="h-4 w-4 shrink-0" />
                </button>
              </div>
            </div>
          </article>
        ) : (
          /* Profile card */
          <div className="flex flex-col w-full text-left">
            {/* Top Photo Frame */}
            <div onTouchStart={event => { const target = event.target as HTMLElement; const photoNavButton = target.closest('[data-testid="profile-photo-prev"], [data-testid="profile-photo-next"]'); const interactiveTarget = target.closest('button, input, select, textarea, a, [role="button"]'); const touch = (!interactiveTarget || photoNavButton) && event.touches.length === 1 ? event.touches[0] : null; photoTouchStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null; }} onTouchEnd={event => { const start = photoTouchStart.current; photoTouchStart.current = null; const touch = event.changedTouches[0]; if (!start || !touch) return; const dx = touch.clientX - start.x; const dy = touch.clientY - start.y; if (Math.abs(dy) >= 48 && Math.abs(dy) > Math.abs(dx) * 1.15) { setPhotoCollapsed(dy < 0); event.preventDefault(); event.stopPropagation(); return; } if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.15 && currentProfile.photos.length > 1) { setPhotoIndex(index => Math.max(0, Math.min(currentProfile.photos.length - 1, index + (dx < 0 ? 1 : -1)))); event.preventDefault(); event.stopPropagation(); } }} onTouchCancel={() => { photoTouchStart.current = null; }} className={"vow-profile-photo relative w-full overflow-hidden bg-stone-950 select-none transition-[height] duration-300 " + (photoCollapsed ? "h-16 sm:h-20" : "h-72 sm:h-80")}>
              <img
                src={currentProfile.photos[photoIndex] || currentProfile.avatar}
                alt={currentProfile.name}
                className="w-full h-full object-cover transition-transform duration-500"
              />

              {/* Photo navigation is only interactive when there are multiple photos. */}
              {!photoCollapsed && currentProfile.photos.length > 1 && (
                <div className="absolute inset-0 flex">
                  <button
                    type="button"
                    data-testid="profile-photo-prev"
                    className="h-full w-1/2 cursor-pointer bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-rose-400"
                    onClick={() => setPhotoIndex(prev => Math.max(0, prev - 1))}
                    onKeyDown={handlePhotoNavigationKeyDown}
                    title={t('previousPhoto')}
                    aria-label={t('previousPhoto')}
                    disabled={photoIndex === 0}
                  />
                  <button
                    type="button"
                    data-testid="profile-photo-next"
                    className="h-full w-1/2 cursor-pointer bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-rose-400"
                    onClick={() => setPhotoIndex(prev => Math.min(currentProfile.photos.length - 1, prev + 1))}
                    onKeyDown={handlePhotoNavigationKeyDown}
                    title={t('nextPhoto')}
                    aria-label={t('nextPhoto')}
                    disabled={photoIndex >= currentProfile.photos.length - 1}
                  />
                </div>
              )}

              {/* Stories / Photo Dots */}
              {!photoCollapsed && currentProfile.photos.length > 1 && (
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

              {!photoCollapsed && <>
              {/* Compatibility badge (Top Left) */}
              <button
                type="button"
                onClick={() => onOpenCompatibilityMatrix(currentProfile)}
                aria-label={t('compatibilityMatrix')}
                className="absolute top-6 left-3 z-20 inline-flex min-h-11 items-center cursor-pointer bg-stone-950/75 hover:bg-stone-950/90 border border-white/15 text-white px-3 py-1 rounded-2xl backdrop-blur-xl gap-2 shadow-lg transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
              >
                <div className="vow-compatibility-orb w-7 h-7 rounded-full p-0.5 flex items-center justify-center font-black text-xs text-white">
                  <div className="w-full h-full rounded-full bg-stone-950 flex items-center justify-center">
                    <span className="text-[10px] font-black">{compatibility.overallScore}%</span>
                  </div>
                </div>
                <div>
                  <div className="text-[9px] text-stone-300 font-semibold flex items-center gap-0.5">
                    <span>{t('compatibility')}</span>
                    <ChevronRight className="w-2.5 h-2.5 text-rose-400" />
                  </div>
                  <div className="text-[10px] font-bold text-emerald-400">
                    {compatibility.overallScore >= 85 ? t('highChemistry') : t('goodConnection')}
                  </div>
                </div>
              </button>

              {/* Verified Anti-Bot Badge (Top Right) */}
              <button
                type="button"
                onClick={() => onInspectBotSafety(currentProfile)}
                className="absolute top-6 right-3 z-20 inline-flex min-h-11 items-center cursor-pointer bg-stone-950/75 hover:bg-stone-950/90 border border-emerald-500/30 text-emerald-400 px-3 py-1 rounded-2xl backdrop-blur-xl gap-1 shadow-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                title={t('livenessVerification')}
                aria-label={t('livenessVerification')}
              >
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-[10px] font-bold text-white">
                  {currentProfile.verification.isVerified ? t('verifiedDemo') : t('notVerified')}
                </span>
              </button>

              {/* Voice Intro Floating Button */}
              {currentProfile.voiceIntroSeconds && (
                <button
                  type="button"
                  onClick={toggleAudio}
                  aria-pressed={isPlayingAudio}
                  aria-label={t('voiceIntroLabel').replace('{seconds}', String(currentProfile.voiceIntroSeconds))}
                  className={`absolute bottom-3 left-3 z-20 flex min-h-11 items-center gap-1.5 px-3 py-1 rounded-full backdrop-blur-xl border text-[11px] font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950 ${
                    isPlayingAudio
                      ? 'bg-rose-600 text-white border-rose-400 red-glow'
                      : 'bg-stone-950/75 hover:bg-stone-900 text-stone-200 border-white/20'
                  }`}
                >
                  {isPlayingAudio ? (
                    <>
                      <VolumeX className="w-3 h-3 animate-pulse" />
                      <span>{t('voiceIntroLabel').replace('{seconds}', String(currentProfile.voiceIntroSeconds))}</span>
                    </>
                  ) : (
                    <>
                      <Volume2 className="w-3 h-3 text-rose-400" />
                      <span>{t('voiceIntroLabel').replace('{seconds}', String(currentProfile.voiceIntroSeconds))}</span>
                    </>
                  )}
                </button>
              )}

              {/* Vignette Shadow */}
              <div className="absolute inset-0 bg-gradient-to-t from-stone-950 via-stone-950/20 to-transparent pointer-events-none"></div>
              </>}
              <button type="button" onClick={() => setPhotoCollapsed(value => !value)} aria-label={photoCollapsed ? t('expandPhoto') : t('collapsePhoto')} aria-expanded={!photoCollapsed} title={photoCollapsed ? t('expandPhoto') : t('collapsePhoto')} className="absolute bottom-2 right-2 z-30 inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full border border-white/20 px-3 bg-stone-950/85 text-white shadow-lg backdrop-blur-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300">{photoCollapsed ? <ChevronDown aria-hidden="true" className="h-4 w-4" /> : <ChevronUp aria-hidden="true" className="h-4 w-4" />}<span className="text-[11px] font-semibold">{photoCollapsed ? t('expandPhoto') : t('collapsePhoto')}</span></button>
            </div>

            {/* Profile Info & Psychological Cards */}
            <div className="vow-profile-details p-3.5 sm:p-4 -mt-5 relative z-10 bg-gradient-to-t from-stone-950 via-stone-950 to-transparent pt-5">
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
                <div className="vow-profile-prompt rounded-2xl bg-stone-900/95 border border-white/10 p-3 mb-3 shadow-inner">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[9px] uppercase font-bold tracking-wider text-rose-400 flex items-center gap-1">
                      <Sparkles className="w-2.5 h-2.5" />
                      {t('profileQuestionCount').replace('{current}', String(activePsychCardIndex + 1)).replace('{total}', String(currentProfile.psychCards.length))}
                    </span>
                    <div className="flex gap-1">
                      {currentProfile.psychCards.map((_, i) => (
                        <button
                          key={i}
                          type="button"
                          onClick={() => setActivePsychCardIndex(i)}
                          aria-label={t('profileQuestionCount').replace('{current}', String(i + 1)).replace('{total}', String(currentProfile.psychCards?.length || 1))}
                          aria-current={i === activePsychCardIndex ? 'step' : undefined}
                          className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
                        >
                          <span className={`block h-3 rounded-full ${i === activePsychCardIndex ? 'w-3 bg-rose-500' : 'w-2 bg-stone-700'}`} />
                        </button>
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
                        {t('profileResonance')}: {currentProfile.psychCards[activePsychCardIndex].matchBonus}%
                      </span>
                      <button
                        type="button"
                        onClick={() => setActivePsychCardIndex((activePsychCardIndex + 1) % (currentProfile.psychCards?.length || 1))}
                        className="inline-flex min-h-11 items-center px-2 text-stone-400 hover:text-white underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
                      >
                        {t('nextPhoto')} →
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
              <div className="vow-profile-actions flex items-center justify-center gap-3 sm:gap-4 pt-1">
                <button
                  type="button"
                  onClick={handleUndo}
                  disabled={history.length === 0}
                  className="vow-motion-button h-11 w-11 min-h-11 min-w-11 rounded-full bg-stone-900 text-stone-300 disabled:text-stone-700 disabled:opacity-50 hover:bg-stone-800 flex items-center justify-center border border-white/10 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950"
                  title={t('undoAction')}
                  aria-label={t('undoAction')}
                >
                  <span className="text-lg leading-none">↶</span>
                </button>
                {/* 1. Pass (Circle) */}
                <button
                  type="button"
                  onClick={handlePassCurrent}
                  className="vow-motion-button vow-pass-button w-12 h-12 rounded-full bg-stone-900 hover:bg-stone-800 text-stone-400 hover:text-white flex items-center justify-center border border-white/10 transition-all hover:scale-110 active:scale-95 shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950"
                  title={t('pass')}
                  aria-label={t('pass')}
                >
                  <X className="w-5 h-5 stroke-[2.5]" />
                </button>

                {/* 2. Compatibility Test Matrix (Compatibility details) */}
                <button
                  type="button"
                  onClick={() => onOpenCompatibilityMatrix(currentProfile)}
                  className="vow-motion-button w-12 h-12 rounded-full bg-stone-900 hover:bg-rose-950/80 text-rose-400 flex items-center justify-center border border-rose-600/40 transition-all hover:scale-110 active:scale-95 shadow-lg shadow-rose-950/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950"
                  title={t('psychCompatibility')}
                  aria-label={t('compatibilityMatrix')}
                >
                  <Zap className="w-5 h-5 fill-rose-500 stroke-rose-400" />
                </button>

                {/* 3. Superlike (Golden Star Circle) */}
                <button
                  type="button"
                  onClick={handleSuperLikeCurrent}
                  className="vow-motion-button w-12 h-12 rounded-full bg-gradient-to-tr from-amber-500 to-amber-600 text-stone-950 flex items-center justify-center font-bold shadow-lg shadow-amber-950/50 transition-all hover:scale-110 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950"
                  title={t('superLike')}
                  aria-label={t('superLike')}
                >
                  <Star className="w-5 h-5 fill-stone-950 stroke-none" />
                </button>

                {/* 4. Like / Connect (Glowing Scarlet Heart Circle) */}
                <button
                  type="button"
                  onClick={handleLikeCurrent}
                  className="vow-motion-button vow-like-button w-14 h-14 rounded-full bg-gradient-to-r from-rose-600 via-red-600 to-rose-700 hover:from-rose-500 hover:to-red-500 text-white flex items-center justify-center red-glow transition-all hover:scale-110 active:scale-95 shadow-xl shadow-rose-950/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950"
                  title={t('likeInvite')}
                  aria-label={t('like')}
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
