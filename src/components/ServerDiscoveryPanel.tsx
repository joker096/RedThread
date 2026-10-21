import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '../i18n/LocaleProvider.tsx';
import { getSwipeActionFromDelta } from '../utils/swipe.ts';

type ServerProfile = {
  id: string;
  displayName: string;
  age: number;
  gender: 'female' | 'male';
  country: string;
  city: string;
  bio: string;
  photoUrls?: string[];
  occupation?: string;
  education?: string;
  languages?: string[];
  relationshipIntent: 'marriage_family' | 'serious_relationship' | 'family_without_marriage';
  familyFormat?: 'marriage' | 'cohabitation' | 'open_to_both';
  hasChildren?: boolean | null;
  wantsChildren?: 'yes' | 'no' | 'discuss' | 'unsure';
  childrenLivingArrangement?: string;
  financialAlignment: number | null;
  compatibilityScore?: number | null;
};

type ServerDiscoveryPanelProps = { onOpenAccount: () => void };

const isSafeProfilePhotoUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 2048) return false;
  const url = value.trim();
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  return /^https?:\/\//i.test(url);
};

const normalizeServerProfile = (value: unknown): ServerProfile | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const profile = value as Partial<ServerProfile>;
  if (typeof profile.id !== 'string' || !profile.id.trim() || profile.id.trim().length > 256 ||
      typeof profile.displayName !== 'string' || !profile.displayName.trim() || profile.displayName.trim().length > 100 ||
      typeof profile.age !== 'number' || !Number.isFinite(profile.age) || profile.age < 18 || profile.age > 120 ||
      (profile.gender !== 'female' && profile.gender !== 'male') ||
      (profile.relationshipIntent !== 'marriage_family' && profile.relationshipIntent !== 'serious_relationship' && profile.relationshipIntent !== 'family_without_marriage')) {
    return null;
  }

  const score = (candidate: unknown): number | null =>
    typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0 && candidate <= 100
      ? candidate
      : null;

  return {
    id: profile.id.trim(),
    displayName: profile.displayName.trim(),
    age: Math.floor(profile.age),
    gender: profile.gender,
    country: typeof profile.country === 'string' ? profile.country.trim().slice(0, 100) : '',
    city: typeof profile.city === 'string' ? profile.city.trim().slice(0, 100) : '',
    bio: typeof profile.bio === 'string' ? profile.bio.trim().slice(0, 2000) : '',
    relationshipIntent: profile.relationshipIntent,
    familyFormat: profile.familyFormat === 'marriage' || profile.familyFormat === 'cohabitation' || profile.familyFormat === 'open_to_both'
      ? profile.familyFormat
      : undefined,
    hasChildren: typeof profile.hasChildren === 'boolean' ? profile.hasChildren : profile.hasChildren === null ? null : undefined,
    wantsChildren: profile.wantsChildren === 'yes' || profile.wantsChildren === 'no' || profile.wantsChildren === 'discuss' || profile.wantsChildren === 'unsure'
      ? profile.wantsChildren
      : undefined,
    childrenLivingArrangement: typeof profile.childrenLivingArrangement === 'string' ? profile.childrenLivingArrangement.trim().slice(0, 200) : undefined,
    occupation: typeof profile.occupation === 'string' ? profile.occupation.trim().slice(0, 120) : undefined,
    education: typeof profile.education === 'string' ? profile.education.trim().slice(0, 120) : undefined,
    financialAlignment: score(profile.financialAlignment),
    compatibilityScore: score(profile.compatibilityScore) ?? undefined,
    photoUrls: Array.isArray(profile.photoUrls)
      ? [...new Set(profile.photoUrls.slice(0, 48).filter(isSafeProfilePhotoUrl).map(url => url.trim()))].slice(0, 12)
      : [],
    languages: Array.isArray(profile.languages)
      ? [...new Set(profile.languages.slice(0, 80)
          .filter((language): language is string => typeof language === 'string' && language.trim().length > 0)
          .map(language => language.trim().slice(0, 40)))].slice(0, 20)
      : []
  };
};

export const ServerDiscoveryPanel: React.FC<ServerDiscoveryPanelProps> = ({ onOpenAccount }) => {
  const { t, formatNumber } = useLocale();
  const [profiles, setProfiles] = useState<ServerProfile[]>([]);
  const [matchedProfile, setMatchedProfile] = useState<ServerProfile | null>(null);
  const matchReturnFocus = useRef<HTMLElement | null>(null);
  const matchDialogRef = useRef<HTMLDivElement | null>(null);
  const matchDialogButtonRef = useRef<HTMLButtonElement | null>(null);
  const [country, setCountry] = useState('');
  const [city, setCity] = useState('');
  const [minAge, setMinAge] = useState(18);
  const [maxAge, setMaxAge] = useState(99);
  const [intent, setIntent] = useState('all');
  const [familyFormat, setFamilyFormat] = useState('all');
  const [childrenFilter, setChildrenFilter] = useState('all');
  const [minFinancialAlignment, setMinFinancialAlignment] = useState(0);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [notice, setNotice] = useState('');
  const [likedIds, setLikedIds] = useState<string[]>([]);
  const [blockedIds, setBlockedIds] = useState<string[]>([]);
  const [blockedProfiles, setBlockedProfiles] = useState<Array<{ id: string; displayName: string }>>([]);
  const [blockedProfilesOpen, setBlockedProfilesOpen] = useState(false);
  const [actionHistory, setActionHistory] = useState<Array<{ type: 'like' | 'pass'; profile: ServerProfile }>>([]);
  const [reportTargetId, setReportTargetId] = useState<string | null>(null);
  const [reportCategory, setReportCategory] = useState('fake_profile');
  const [reportDetails, setReportDetails] = useState('');
  const [swipeMode, setSwipeMode] = useState(false);
  const [selectedPhoto, setSelectedPhoto] = useState<{ profileId: string; index: number } | null>(null);
  const [collapsedPhotoProfileId, setCollapsedPhotoProfileId] = useState<string | null>(null);
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  const lastSearchKey = useRef<string | null>(null);
  const searchRequestId = useRef(0);
  const searchAbortController = useRef<AbortController | null>(null);
  const sessionEpoch = useRef(0);

  useEffect(() => {
    if (!matchedProfile) return;
    const dialog = matchDialogRef.current;
    const previousFocus = matchReturnFocus.current;
    matchDialogButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMatchedProfile(null);
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).filter(element => !element.closest('[aria-hidden="true"], [hidden], [inert]'));
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
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
      if (previousFocus?.isConnected) previousFocus.focus();
      matchReturnFocus.current = null;
    };
  }, [matchedProfile]);

  const search = useCallback(async () => {
    searchAbortController.current?.abort();
    const controller = new AbortController();
    searchAbortController.current = controller;
    const requestId = ++searchRequestId.current;
    setBusy(true);
    setSearchFailed(false);
    setNotice('');
    const params = new URLSearchParams({
      minAge: String(minAge),
      maxAge: String(maxAge),
      minFinancialAlignment: String(minFinancialAlignment),
      limit: '50'
    });
    if (country.trim()) params.set('country', country.trim());
    if (city.trim()) params.set('city', city.trim());
    if (intent !== 'all') params.set('intent', intent);
    if (familyFormat !== 'all') params.set('familyFormat', familyFormat);
    if (childrenFilter !== 'all') params.set('hasChildren', childrenFilter);
    const searchKey = params.toString();
    if (lastSearchKey.current !== searchKey) {
      lastSearchKey.current = searchKey;
      setActionHistory([]);
    }
    try {
      const response = await fetch(`/api/profiles/search?${searchKey}`, { credentials: 'include', signal: controller.signal });
      if (requestId !== searchRequestId.current) return;
      if (response.status === 401) {
        setAuthenticated(false);
        setProfiles([]);
        return;
      }
      if (response.status === 402) {
        const data = await response.json().catch(() => null);
        setProfiles([]);
        setAuthenticated(true);
        setNotice(data?.message || t('trialEndedSearch'));
        return;
      }
      if (!response.ok) throw new Error(t('searchSetupError'));
      const data = await response.json();
      if (requestId !== searchRequestId.current) return;
      const seenProfileIds = new Set<string>();
      const nextProfiles: ServerProfile[] = Array.isArray(data?.profiles)
        ? data.profiles
            .map(normalizeServerProfile)
            .filter((profile: ServerProfile | null): profile is ServerProfile => {
              if (!profile || seenProfileIds.has(profile.id)) return false;
              seenProfileIds.add(profile.id);
              return true;
            })
        : [];
      setProfiles(nextProfiles);
      setAuthenticated(true);
      setSearchFailed(false);
      setNotice(nextProfiles.length ? `${t('registeredProfiles')}: ${formatNumber(nextProfiles.length)}` : t('noProfilesForFilters'));
    } catch (error) {
      if (requestId === searchRequestId.current) {
        setProfiles([]);
        setSearchFailed(true);
        setNotice(error instanceof Error ? error.message : t('connectionError'));
      }
    } finally {
      if (requestId === searchRequestId.current) {
        setBusy(false);
        if (searchAbortController.current === controller) searchAbortController.current = null;
      }
    }
  }, [minAge, maxAge, minFinancialAlignment, country, city, intent, familyFormat, childrenFilter, t, formatNumber]);

  useEffect(() => {
    void search();
    return () => {
      searchRequestId.current += 1;
      searchAbortController.current?.abort();
      searchAbortController.current = null;
    };
  }, [search]);

  useEffect(() => {
    const refreshOnSession = () => {
      sessionEpoch.current += 1;
      searchRequestId.current += 1;
      lastSearchKey.current = null;
      setAuthenticated(null);
      setProfiles([]);
      setLikedIds([]);
      setBlockedIds([]);
      setBlockedProfiles([]);
      setBlockedProfilesOpen(false);
      setActionHistory([]);
      setMatchedProfile(null);
      setReportTargetId(null);
      setReportDetails('');
      void search();
    };
    window.addEventListener('vow:session-changed', refreshOnSession);
    return () => window.removeEventListener('vow:session-changed', refreshOnSession);
  }, [search]);

  const like = async (profile: ServerProfile) => {
    if (busy || likedIds.includes(profile.id)) return;
    const actionEpoch = sessionEpoch.current;
    setBusy(true);
    try {
      const response = await fetch(`/api/likes/${encodeURIComponent(profile.id)}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await response.json().catch(() => null);
      if (actionEpoch !== sessionEpoch.current) return;
      if (response.status === 401) {
        setAuthenticated(false);
        setNotice(t('signInToLike'));
        return;
      }
      if (response.status === 402) throw new Error(data?.message || t('trialEndedLike'));
      if (!response.ok) throw new Error(t('sendLikeError'));
      if (!data?.matched) setActionHistory(current => [...current, { type: 'like' as const, profile }].slice(-50));
      setLikedIds(current => current.includes(profile.id) ? current : [...current, profile.id]);
      setNotice(data?.matched
        ? t('mutualLikeOpenedChats').replace('{name}', profile.displayName)
        : `${t('liked')}: «${profile.displayName}».`);
      if (data?.matched) {
        matchReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setMatchedProfile(profile);
      }
      setProfiles(current => current.filter(item => item.id !== profile.id));
    } catch (error) {
      if (actionEpoch === sessionEpoch.current) {
        setNotice(error instanceof Error ? error.message : t('sendLikeError'));
      }
    } finally {
      if (actionEpoch === sessionEpoch.current) setBusy(false);
    }
  };

  const pass = async (profile: ServerProfile) => {
    if (busy) return;
    const actionEpoch = sessionEpoch.current;
    setBusy(true);
    try {
      const response = await fetch(`/api/passes/${encodeURIComponent(profile.id)}`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
      });
      const data = await response.json().catch(() => null);
      if (actionEpoch !== sessionEpoch.current) return;
      if (response.status === 401) {
        setAuthenticated(false);
        setNotice(t('signInToPass'));
        return;
      }
      if (response.status === 402) throw new Error(data?.message || t('trialEndedPass'));
      if (!response.ok) throw new Error(t('passError'));
      setActionHistory(current => [...current, { type: 'pass' as const, profile }].slice(-50));
      setProfiles(current => current.filter(item => item.id !== profile.id));
      setNotice(t('passedProfileNotice'));
    } catch (error) {
      if (actionEpoch === sessionEpoch.current) {
        setNotice(error instanceof Error ? error.message : t('passError'));
      }
    } finally {
      if (actionEpoch === sessionEpoch.current) setBusy(false);
    }
  };

  const undoPass = async () => {
    if (busy) return;
    const actionEpoch = sessionEpoch.current;
    const lastAction = actionHistory[actionHistory.length - 1];
    setBusy(true);
    try {
      if (lastAction?.type === 'like') {
        const response = await fetch(`/api/likes/${encodeURIComponent(lastAction.profile.id)}`, {
          method: 'DELETE', credentials: 'include',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
        });
        if (actionEpoch !== sessionEpoch.current) return;
        if (response.status === 401) {
          setAuthenticated(false);
          setNotice(t('signInToUndoLike'));
          return;
        }
        if (response.status === 409) throw new Error(t('undoLikeMatchError'));
        if (!response.ok) throw new Error(t('undoLikeError'));
        setLikedIds(current => current.filter(id => id !== lastAction.profile.id));
        setProfiles(current => current.some(item => item.id === lastAction.profile.id)
          ? current
          : [lastAction.profile, ...current]);
        setActionHistory(current => current.slice(0, -1));
        setNotice(t('undoLikeSuccess').replace('{name}', lastAction.profile.displayName));
        return;
      }

      const response = lastAction
        ? await fetch('/api/passes/undo', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetId: lastAction.profile.id })
          })
        : await fetch('/api/discovery/undo', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
          });
      const data = await response.json().catch(() => null);
      if (actionEpoch !== sessionEpoch.current) return;
      if (response.status === 401) {
        setAuthenticated(false);
        setNotice(t('signInToUndoAction'));
        return;
      }
      if (response.status === 402) throw new Error(data?.message || t('premiumUndoRequired'));
      if (response.status === 404) throw new Error(t('undoUnavailable'));
      if (response.status === 409) throw new Error(t('undoMatchError'));
      if (!response.ok) throw new Error(t('undoActionError'));
      const restoredProfile = normalizeServerProfile(data?.profile);
      if (
        !restoredProfile ||
        (data.type !== 'like' && data.type !== 'pass') ||
        (lastAction && data.type !== lastAction.type)
      ) {
        throw new Error(t('undoActionError'));
      }
      if (actionEpoch !== sessionEpoch.current) return;
      setProfiles(current => [restoredProfile, ...current.filter(item => item.id !== restoredProfile.id)]);
      if (data.type === 'like') setLikedIds(current => current.filter(id => id !== restoredProfile.id));
      if (lastAction) setActionHistory(current => current.slice(0, -1));
      setNotice(data.type === 'like'
        ? t('undoLikeSuccess').replace('{name}', restoredProfile.displayName)
        : t('undoPassSuccess'));
    } catch (error) {
      if (actionEpoch === sessionEpoch.current) setNotice(error instanceof Error ? error.message : t('undoActionError'));
    } finally {
      if (actionEpoch === sessionEpoch.current) setBusy(false);
    }
  };

  const submitReport = async (profile: ServerProfile) => {
    if (busy) return;
    const actionEpoch = sessionEpoch.current;
    setBusy(true);
    try {
      const response = await fetch('/api/reports', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportedUserId: profile.id, category: reportCategory, details: reportDetails.trim() })
      });
      const data = await response.json().catch(() => null);
      if (actionEpoch !== sessionEpoch.current) return;
      if (response.status === 401) {
        setAuthenticated(false);
        setNotice(t('signInToReport'));
        return;
      }
      if (!response.ok) throw new Error(data?.error === 'invalid_report_details' ? t('invalidReportDetails') : t('reportError'));
      setReportTargetId(null);
      setReportDetails('');
      setNotice(t('reportSuccess'));
    } catch (error) {
      if (actionEpoch === sessionEpoch.current) setNotice(error instanceof Error ? error.message : t('reportError'));
    } finally {
      if (actionEpoch === sessionEpoch.current) setBusy(false);
    }
  };

  const block = async (profile: ServerProfile) => {
    if (busy) return;
    const actionEpoch = sessionEpoch.current;
    setBusy(true);
    try {
      const response = await fetch(`/api/blocks/${encodeURIComponent(profile.id)}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      if (actionEpoch !== sessionEpoch.current) return;
      if (response.status === 401) {
        setAuthenticated(false);
        setNotice(t('signInToBlock'));
        return;
      }
      if (!response.ok) throw new Error(t('blockError'));
      setBlockedIds(current => current.includes(profile.id) ? current : [...current, profile.id]);
      setActionHistory(current => current.filter(action => action.profile.id !== profile.id));
      setLikedIds(current => current.filter(id => id !== profile.id));
      setProfiles(current => current.filter(item => item.id !== profile.id));
      setNotice(t('blockedProfileNotice').replace('{name}', profile.displayName));
    } catch (error) {
      if (actionEpoch === sessionEpoch.current) setNotice(error instanceof Error ? error.message : t('blockOperationError'));
    } finally {
      if (actionEpoch === sessionEpoch.current) setBusy(false);
    }
  };

  const toggleBlockedProfiles = async () => {
    if (blockedProfilesOpen) {
      setBlockedProfilesOpen(false);
      return;
    }
    if (busy) return;
    const actionEpoch = sessionEpoch.current;
    setBusy(true);
    try {
      const response = await fetch('/api/blocks', { credentials: 'include' });
      if (actionEpoch !== sessionEpoch.current) return;
      if (response.status === 401) {
        setAuthenticated(false);
        setNotice(t('signInToBlock'));
        return;
      }
      if (!response.ok) throw new Error(t('blockedProfilesLoadError'));
      const data = await response.json();
      if (actionEpoch !== sessionEpoch.current) return;
      const nextProfiles: Array<{ id: string; displayName: string }> = Array.isArray(data?.blocks)
        ? (data.blocks as unknown[]).filter((item: unknown): item is { id: string; displayName: string } =>
            Boolean(item && typeof item === 'object' &&
              typeof (item as { id?: unknown }).id === 'string' &&
              typeof (item as { displayName?: unknown }).displayName === 'string'))
        : [];
      setBlockedProfiles(nextProfiles);
      setBlockedIds(nextProfiles.map(item => item.id));
      setBlockedProfilesOpen(true);
    } catch (error) {
      if (actionEpoch === sessionEpoch.current) setNotice(error instanceof Error ? error.message : t('blockedProfilesLoadError'));
    } finally {
      if (actionEpoch === sessionEpoch.current) setBusy(false);
    }
  };

  const unblock = async (profile: { id: string; displayName: string }) => {
    if (busy) return;
    const actionEpoch = sessionEpoch.current;
    setBusy(true);
    try {
      const response = await fetch(`/api/blocks/${encodeURIComponent(profile.id)}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (actionEpoch !== sessionEpoch.current) return;
      if (response.status === 401) {
        setAuthenticated(false);
        setNotice(t('signInToBlock'));
        return;
      }
      if (!response.ok) throw new Error(t('blockOperationError'));
      setBlockedProfiles(current => current.filter(item => item.id !== profile.id));
      setBlockedIds(current => current.filter(id => id !== profile.id));
      setNotice(t('unblockSuccess').replace('{name}', profile.displayName));
    } catch (error) {
      if (actionEpoch === sessionEpoch.current) setNotice(error instanceof Error ? error.message : t('blockOperationError'));
    } finally {
      if (actionEpoch === sessionEpoch.current) setBusy(false);
    }
  };

  return (
    <section aria-busy={busy} className="vow-screen mb-5 rounded-3xl border border-emerald-500/20 bg-stone-900/80 p-4 sm:p-5">
      <div className="mb-3">
        <p className="text-[10px] uppercase tracking-[0.2em] text-emerald-300">{t('serverSearchEyebrow')}</p>
        <h3 className="mt-1 text-lg font-bold text-white">{t('serverProfilesTitle')}</h3>
        <p className="mt-1 text-xs leading-relaxed text-stone-400">{t('realProfilesNote')}</p>
      </div>
      {authenticated === false ? (
        <div className="rounded-2xl border border-white/10 bg-stone-950/60 p-4">
          <p className="text-sm text-stone-200">{t('signInToSearch')}</p>
          <button type="button" onClick={onOpenAccount} className="mt-3 min-h-11 rounded-xl bg-rose-600 px-4 py-2.5 text-xs font-bold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400">{t('login')}</button>
        </div>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
            <label className="text-xs text-stone-300">{t('country')}<input name="filter-country" value={country} onChange={e => setCountry(e.target.value)} placeholder={t('anyCountry')} className="mt-1 min-h-11 w-full rounded-xl border border-white/10 bg-stone-950 p-2.5 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400" /></label>
            <label className="text-xs text-stone-300">{t('city')}<input name="filter-city" value={city} onChange={e => setCity(e.target.value)} placeholder={t('anyCity')} className="mt-1 min-h-11 w-full rounded-xl border border-white/10 bg-stone-950 p-2.5 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400" /></label>
            <label className="text-xs text-stone-300">{t('ageFrom')}<input name="filter-age-from" type="number" min="18" max={maxAge} value={minAge} onChange={e => setMinAge(Math.min(maxAge, Math.max(18, Number(e.target.value) || 18)))} className="mt-1 min-h-11 w-full rounded-xl border border-white/10 bg-stone-950 p-2.5 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400" /></label>
            <label className="text-xs text-stone-300">{t('ageTo')}<input name="filter-age-to" type="number" min={minAge} max="120" value={maxAge} onChange={e => setMaxAge(Math.max(minAge, Math.min(120, Number(e.target.value) || minAge)))} className="mt-1 min-h-11 w-full rounded-xl border border-white/10 bg-stone-950 p-2.5 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400" /></label>
            <label className="text-xs text-stone-300">{t('relationshipGoal')}<select name="filter-relationship-goal" value={intent} onChange={e => setIntent(e.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-white/10 bg-stone-950 p-2.5 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"><option value="all">{t('any')}</option><option value="marriage_family">{t('marriageFamily')}</option><option value="family_without_marriage">{t('familyWithoutMarriage')}</option><option value="serious_relationship">{t('seriousRelationship')}</option></select></label>
            <label className="text-xs text-stone-300">{t('familyFormat')}<select name="filter-family-format" value={familyFormat} onChange={e => setFamilyFormat(e.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-white/10 bg-stone-950 p-2.5 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"><option value="all">{t('anyFormat')}</option><option value="marriage">{t('marriageOnly')}</option><option value="cohabitation">{t('cohabitation')}</option><option value="open_to_both">{t('openToBoth')}</option></select></label>
            <label className="text-xs text-stone-300">{t('children')}<select name="filter-children" value={childrenFilter} onChange={e => setChildrenFilter(e.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-white/10 bg-stone-950 p-2.5 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"><option value="all">{t('notImportant')}</option><option value="false">{t('noChildren')}</option><option value="true">{t('hasChildren')}</option></select></label>
            <label className="text-xs text-stone-300">{t('financialMatch')}<select name="filter-financial-alignment" value={minFinancialAlignment} onChange={e => setMinFinancialAlignment(Number(e.target.value))} className="mt-1 min-h-11 w-full rounded-xl border border-white/10 bg-stone-950 p-2.5 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"><option value="0">{t('doNotFilter')}</option><option value="33">{t('financialFrom33')}</option><option value="67">{t('financialFrom67')}</option><option value="100">{t('financialOnly100')}</option></select></label>
          </div>
          <button type="button" onClick={() => void search()} disabled={busy} className="mb-2 min-h-11 w-full rounded-xl bg-emerald-700 px-4 py-3 text-sm font-bold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:opacity-50">{busy ? t('searching') : t('search')}</button>
          <button type="button" onClick={() => setSwipeMode(value => !value)} aria-pressed={swipeMode} className="mb-3 min-h-11 w-full rounded-xl border border-emerald-500/30 px-4 py-2.5 text-xs font-semibold text-emerald-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400">{swipeMode ? t('listMode') : t('swipeMode')}</button>
          <button type="button" onClick={() => void undoPass()} disabled={busy} className="mb-3 min-h-11 w-full rounded-xl border border-amber-500/30 px-4 py-2.5 text-xs font-semibold text-amber-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:opacity-50">↶ {t('undoAction')}</button>
          <button type="button" onClick={() => void toggleBlockedProfiles()} disabled={busy} aria-expanded={blockedProfilesOpen} aria-controls="blocked-profiles-panel" className="mb-3 min-h-11 w-full rounded-xl border border-white/10 px-4 py-2.5 text-xs font-semibold text-stone-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:opacity-50">
            {blockedProfilesOpen ? t('hideBlockedProfiles') : t('manageBlockedProfiles')}
          </button>
          {blockedProfilesOpen && (
            <section id="blocked-profiles-panel" aria-label={t('blockedProfilesTitle')} className="mb-4 rounded-2xl border border-white/10 bg-stone-950/60 p-3">
              <h4 className="mb-2 text-sm font-semibold text-white">{t('blockedProfilesTitle')}</h4>
              {blockedProfiles.length === 0 ? (
                <p className="text-xs text-stone-400">{t('blockedProfilesEmpty')}</p>
              ) : (
                <ul className="space-y-2">
                  {blockedProfiles.map(profile => (
                    <li key={profile.id} className="flex items-center justify-between gap-3 rounded-xl border border-white/5 p-2">
                      <span className="min-w-0 truncate text-xs text-stone-200">{profile.displayName}</span>
                      <button type="button" onClick={() => void unblock(profile)} disabled={busy} className="min-h-11 min-w-11 shrink-0 rounded-lg border border-emerald-500/30 px-3 py-2 text-xs font-semibold text-emerald-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:opacity-50">{t('unblock')}</button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {swipeMode && <p className="mb-3 text-[11px] text-stone-400">{t('swipeHint')}</p>}
          {notice && <p role="status" aria-live="polite" aria-atomic="true" className="mb-3 text-xs text-stone-300">{notice}</p>}
          {!busy && authenticated === true && profiles.length === 0 && (searchFailed || notice === t('noProfilesForFilters')) && (
            <div className="mb-3 rounded-2xl border border-white/10 bg-stone-950/60 p-4 text-center" aria-live="polite">
              <p className="text-sm font-semibold text-stone-200">{searchFailed ? (notice || t('connectionError')) : t('noProfilesForFilters')}</p>
              {!searchFailed && <p className="mt-1 text-xs leading-relaxed text-stone-400">{t('demoFilterHint')}</p>}
              <button type="button" onClick={() => void search()} className="mt-3 min-h-11 rounded-xl border border-emerald-500/30 px-4 py-2.5 text-sm font-semibold text-emerald-200 hover:bg-emerald-950/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300">{t('retry')}</button>
            </div>
          )}
          {busy && <p role="status" aria-live="polite" aria-atomic="true" className="mb-3 rounded-xl border border-white/10 bg-stone-950/40 px-3 py-3 text-center text-xs text-stone-300">{t('searching')}</p>}
          <div aria-busy={busy} className={swipeMode ? 'mx-auto max-w-lg space-y-3' : 'space-y-3'}>
            {profiles.slice(0, swipeMode ? 1 : profiles.length).map((profile, profileIndex) => (
              <article key={profile.id}
                onTouchStart={event => {
                  if (swipeMode && !(event.target as HTMLElement).closest('button, input, select, textarea')) {
                    touchStartX.current = event.changedTouches[0]?.clientX ?? null;
                    touchStartY.current = event.changedTouches[0]?.clientY ?? null;
                    event.currentTarget.style.transition = 'none';
                  }
                }}
                onTouchMove={event => {
                  if (!swipeMode || touchStartX.current === null || (event.target as HTMLElement).closest('button, input, select, textarea')) return;
                  const currentY = event.changedTouches[0]?.clientY;
                  if (currentY !== undefined && touchStartY.current !== null && Math.abs(currentY - touchStartY.current) > Math.abs((event.changedTouches[0]?.clientX ?? touchStartX.current) - touchStartX.current)) return;
                  const currentX = event.changedTouches[0]?.clientX;
                  if (currentX === undefined) return;
                  const delta = currentX - touchStartX.current;
                  const tilt = Math.max(-7, Math.min(7, delta / 24));
                  event.currentTarget.style.transform = `translateX(${delta}px) rotate(${tilt}deg)`;
                }}
                onTouchEnd={event => {
                  const start = touchStartX.current;
                  const startY = touchStartY.current;
                  touchStartX.current = null;
                  touchStartY.current = null;
                  event.currentTarget.style.transition = '';
                  event.currentTarget.style.transform = '';
                  if (!swipeMode || (event.target as HTMLElement).closest('button, input, select, textarea') || start === null) return;
                  const touch = event.changedTouches[0];
                  const endX = touch?.clientX;
                  const endY = touch?.clientY;
                  if (endX === undefined || endY === undefined || startY === null) return;
                  const deltaX = endX - start;
                  const deltaY = endY - startY;
                  if (Math.abs(deltaY) >= Math.abs(deltaX)) return;
                  const action = getSwipeActionFromDelta(deltaX);
                  if (action === 'like') void like(profile);
                  else if (action === 'pass') void pass(profile);
                }}
                role={swipeMode ? 'group' : undefined}
                aria-label={swipeMode ? t('swipeProfileAria').replace('{name}', profile.displayName) : undefined}
                className={`vow-profile-card rounded-2xl border border-white/10 bg-stone-950/70 p-3 ${swipeMode ? 'touch-pan-y' : ''}`}>
                {profile.photoUrls?.length ? (
                  <div className="mb-4 space-y-2.5">
                    {swipeMode && (
                      <button
                        type="button"
                        onClick={() => setCollapsedPhotoProfileId(current => current === profile.id ? null : profile.id)}
                        aria-expanded={collapsedPhotoProfileId !== profile.id}
                        className="flex min-h-11 w-full items-center justify-center rounded-xl border border-white/10 px-3 py-2 text-xs font-semibold text-stone-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
                      >
                        {collapsedPhotoProfileId === profile.id ? t('expandPhoto') : t('collapsePhoto')}
                      </button>
                    )}
                    {collapsedPhotoProfileId !== profile.id && (
                      <>
                        {(() => {
                          const photoUrls = profile.photoUrls ?? [];
                          const selectedIndex = selectedPhoto?.profileId === profile.id && selectedPhoto.index < photoUrls.length
                            ? selectedPhoto.index
                            : 0;
                          return (
                            <img
                              key={photoUrls[selectedIndex]}
                              src={photoUrls[selectedIndex]}
                              alt={t('photoAlt').replace('{name}', profile.displayName).replace('{number}', String(selectedIndex + 1))}
                              loading="lazy"
                              decoding="async"
                              draggable={false}
                              referrerPolicy="no-referrer"
                              className={swipeMode
                                ? 'h-[min(42vh,320px)] w-full rounded-2xl border border-white/10 bg-stone-900 object-contain'
                                : 'h-44 w-full rounded-xl border border-white/10 bg-stone-900 object-contain'}
                            />
                          );
                        })()}
                        {profile.photoUrls.length > 1 && (
                          <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label={t('profileUploadedPhotos')}>
                            {profile.photoUrls.map((url, index) => {
                              const isSelected = (selectedPhoto?.profileId === profile.id && selectedPhoto.index < profile.photoUrls.length ? selectedPhoto.index : 0) === index;
                              return (
                                <button
                                  key={url}
                                  type="button"
                                  onClick={() => setSelectedPhoto({ profileId: profile.id, index })}
                                  aria-label={t('photoAlt').replace('{name}', profile.displayName).replace('{number}', String(index + 1))}
                                  aria-pressed={isSelected}
                                  className={'min-h-14 min-w-14 h-14 w-14 shrink-0 overflow-hidden rounded-lg border-2 bg-stone-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 ' + (isSelected ? 'border-rose-400' : 'border-white/15')}
                                >
                                  <img src={url} alt="" loading="lazy" decoding="async" draggable={false} referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                ) : (
                  <div className="mb-3 flex h-20 items-center justify-center rounded-xl border border-dashed border-white/10 text-xs text-stone-500">{t('noPhotos')}</div>
                )}
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h4 className="font-semibold text-white">{profile.displayName}, {profile.age}</h4>
                    <p className="mt-1 text-xs text-stone-400">{profile.city}, {profile.country}</p>
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                    {profile.compatibilityScore !== null && profile.compatibilityScore !== undefined && <span className="rounded-full border border-rose-500/30 px-2 py-1 text-[10px] text-rose-200">{t('compatibilityScore')} {profile.compatibilityScore}%</span>}
                    {profile.financialAlignment !== null && <span className="rounded-full border border-emerald-500/30 px-2 py-1 text-[10px] text-emerald-300">{t('finance')} {profile.financialAlignment}%</span>}
                  </div>
                </div>
                {profile.bio && <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-stone-300">{profile.bio}</p>}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {profile.relationshipIntent === 'family_without_marriage' && <span className="rounded-full border border-amber-500/20 bg-amber-950/30 px-2 py-1 text-[10px] text-amber-200">{t('familyWithoutMarriage')}</span>}
                  {profile.familyFormat === 'cohabitation' && <span className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-stone-300">{t('cohabitation')}</span>}
                  {profile.hasChildren === true && <span className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-stone-300">{t('hasChildren')}</span>}
                  {profile.hasChildren === false && <span className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-stone-400">{t('noChildren')}</span>}
                  {profile.wantsChildren === 'yes' && <span className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-stone-300">{t('childrenWant')}</span>}
                  {profile.wantsChildren === 'no' && <span className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-stone-300">{t('childrenNoWant')}</span>}
                </div>
                {(profile.occupation || profile.education) && <p className="mt-2 text-xs text-stone-400">{[profile.occupation, profile.education].filter(Boolean).join(' · ')}</p>}
                {profile.languages?.length ? <p className="mt-1 text-xs text-stone-400">{t('languages')}: {profile.languages.join(', ')}</p> : null}
                <p className="mt-2 text-[10px] text-stone-500">{profile.relationshipIntent === 'marriage_family' ? t('profileMarriage') : t('profileSerious')}</p>
                <div className="mt-4 grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
                  <button type="button" onClick={() => void pass(profile)} disabled={busy} className="vow-motion-button vow-pass-button flex min-h-12 items-center justify-center rounded-xl border border-white/10 px-3 py-3 text-sm font-semibold text-stone-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:opacity-50">{t('pass')}</button>
                  <button type="button" onClick={() => void like(profile)} disabled={busy || likedIds.includes(profile.id)} className="vow-motion-button vow-like-button flex min-h-12 items-center justify-center rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-3 text-sm font-bold text-rose-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:opacity-50">{likedIds.includes(profile.id) ? t('liked') : t('like')}</button>
                </div>
                <div className="mt-2 grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
                  <button type="button" onClick={() => void block(profile)} disabled={busy || blockedIds.includes(profile.id)} className="min-h-11 rounded-xl border border-white/10 px-3 py-2 text-xs text-stone-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:opacity-50">{t('block')}</button>
                  <button type="button" onClick={() => { setReportTargetId(reportTargetId === profile.id ? null : profile.id); setReportCategory('fake_profile'); setReportDetails(''); }} aria-expanded={reportTargetId === profile.id} aria-controls={`report-panel-${profile.id}`} className="min-h-11 rounded-xl border border-white/10 px-3 py-2 text-xs text-stone-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400">{t('report')}</button>
                </div>
                {reportTargetId === profile.id && (
                  <div id={`report-panel-${profile.id}`} className="mt-2 space-y-2 rounded-xl border border-white/10 bg-stone-900 p-3">
                    <label htmlFor={`discovery-report-category-${profileIndex}`} className="block text-xs text-stone-300">{t('reportReason')}<select id={`discovery-report-category-${profileIndex}`} name="report-category" value={reportCategory} onChange={e => setReportCategory(e.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-white/10 bg-stone-950 p-2 text-xs text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"><option value="fake_profile">{t('reportFake')}</option><option value="spam">{t('reportSpam')}</option><option value="harassment">{t('reportHarassment')}</option><option value="safety">{t('reportSafety')}</option><option value="children_misrepresentation">{t('reportChildren')}</option><option value="duplicate_profile">{t('reportDuplicate')}</option><option value="other">{t('reportOther')}</option></select></label>
                    <label htmlFor={`discovery-report-details-${profileIndex}`} className="block text-xs text-stone-300">{t('reportComment')}<textarea id={`discovery-report-details-${profileIndex}`} name="report-details" value={reportDetails} onChange={e => setReportDetails(e.target.value)} maxLength={2000} rows={2} className="mt-1 min-h-11 w-full rounded-lg border border-white/10 bg-stone-950 p-2 text-xs text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400" /></label>
                    <button type="button" onClick={() => void submitReport(profile)} disabled={busy} className="min-h-11 w-full rounded-lg bg-rose-700 px-3 py-2 text-xs font-bold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:opacity-50">{busy ? t('sending') : t('sendReport')}</button>
                  </div>
                )}
              </article>
            ))}
          </div>
        </>
      )}
      {matchedProfile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" onClick={event => {
          if (event.target === event.currentTarget) setMatchedProfile(null);
        }}>
          <div ref={matchDialogRef} role="dialog" aria-modal="true" aria-labelledby="discovery-match-dialog-title" aria-describedby="discovery-match-dialog-description" tabIndex={-1} className="w-full max-w-sm rounded-3xl border border-rose-400/30 bg-stone-950 p-6 text-center shadow-2xl shadow-rose-950/40">
            <div className="vow-match-celebration mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full border border-rose-400/30 bg-rose-950/50 text-4xl text-rose-300" aria-hidden="true">♥</div>
            {matchedProfile.photoUrls?.[0] && <img src={matchedProfile.photoUrls[0]} alt="" decoding="async" className="mx-auto mb-4 h-20 w-20 rounded-full border border-rose-400/30 object-cover" />}
            <h3 id="discovery-match-dialog-title" className="text-xl font-bold text-white">{t('mutualMatches')}</h3>
            <p id="discovery-match-dialog-description" className="mt-3 text-sm leading-relaxed text-stone-300">{t('mutualLikeOpenedChats').replace('{name}', matchedProfile.displayName)}</p>
            <button ref={matchDialogButtonRef} type="button" onClick={() => {
              setMatchedProfile(null);
              window.dispatchEvent(new CustomEvent('vow:match-created'));
            }} className="vow-motion-button mt-5 w-full rounded-xl bg-rose-600 px-4 py-3 text-sm font-bold text-white hover:bg-rose-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400">{t('sendMessage')}</button>
          </div>
        </div>
      )}
    </section>
  );
};
