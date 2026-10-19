import React, { useEffect, useRef, useState } from 'react';
import { useLocale } from '../i18n/LocaleProvider.tsx';

type Profile = {
  id: string; displayName: string; age: number; gender: 'female' | 'male';
  country: string; city: string; bio: string; photoUrls: string[];
  occupation: string; education: string; languages: string[];
  relationshipIntent: 'marriage_family' | 'serious_relationship' | 'family_without_marriage'; isVisible: boolean;
  familyFormat: 'marriage' | 'cohabitation' | 'open_to_both'; hasChildren: boolean | null;
  childrenDisclosureConfirmedAt: string | null; wantsChildren: 'yes' | 'no' | 'discuss' | 'unsure';
  childrenLivingArrangement: 'with_me' | 'shared_custody' | 'with_other_parent' | 'not_applicable' | 'prefer_to_discuss';
};
type BlockedProfile = { id: string; displayName: string; createdAt: string };

const safeProfileText = (value: unknown, maxLength: number): string =>
  typeof value === 'string' ? value.slice(0, maxLength) : '';
const safeProfileChoice = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback;
type Props = { onOpenAccount: () => void };

export const ProfileEditorPanel: React.FC<Props> = ({ onOpenAccount }) => {
  const { t } = useLocale();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [country, setCountry] = useState('');
  const [city, setCity] = useState('');
  const [occupation, setOccupation] = useState('');
  const [education, setEducation] = useState('');
  const [photoUrls, setPhotoUrls] = useState('');
  const [languages, setLanguages] = useState('');
  const [relationshipIntent, setRelationshipIntent] = useState<'marriage_family' | 'serious_relationship' | 'family_without_marriage'>('marriage_family');
  const [familyFormat, setFamilyFormat] = useState<'marriage' | 'cohabitation' | 'open_to_both'>('open_to_both');
  const [hasChildren, setHasChildren] = useState<boolean | null>(null);
  const [wantsChildren, setWantsChildren] = useState<'yes' | 'no' | 'discuss' | 'unsure'>('discuss');
  const [childrenLivingArrangement, setChildrenLivingArrangement] = useState<'with_me' | 'shared_custody' | 'with_other_parent' | 'not_applicable' | 'prefer_to_discuss'>('not_applicable');
  const [isVisible, setIsVisible] = useState(true);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [blockedProfiles, setBlockedProfiles] = useState<BlockedProfile[]>([]);
  const [unblockingIds, setUnblockingIds] = useState<Set<string>>(() => new Set());
  const unblockingIdsRef = useRef<Set<string>>(new Set());
  const profileLoadRequestId = useRef(0);

  const load = async () => {
    const requestId = ++profileLoadRequestId.current;
    try {
      const response = await fetch('/api/profiles/me', { credentials: 'include' });
      if (requestId !== profileLoadRequestId.current) return;
      if (response.status === 401) {
        profileLoadRequestId.current += 1;
        setAuthenticated(false);
        setProfile(null);
        setDisplayName('');
        setBio('');
        setCountry('');
        setCity('');
        setOccupation('');
        setEducation('');
        setPhotoUrls('');
        setLanguages('');
        setRelationshipIntent('marriage_family');
        setFamilyFormat('open_to_both');
        setHasChildren(null);
        setWantsChildren('discuss');
        setChildrenLivingArrangement('not_applicable');
        setIsVisible(true);
        setBlockedProfiles([]);
        unblockingIdsRef.current.clear();
        setUnblockingIds(new Set());
        setBusy(false);
        setUploadBusy(false);
        return;
      }
      if (!response.ok) throw new Error(t('profileLoadError'));
      const data = await response.json();
      if (requestId !== profileLoadRequestId.current) return;
      const rawProfile = data?.profile;
      if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile) ||
          typeof rawProfile.id !== 'string' || !rawProfile.id.trim() || rawProfile.id.trim().length > 256 ||
          typeof rawProfile.displayName !== 'string' || !rawProfile.displayName.trim() || rawProfile.displayName.trim().length > 80 ||
          typeof rawProfile.age !== 'number' || !Number.isFinite(rawProfile.age) || rawProfile.age < 18 || rawProfile.age > 120 ||
          !['female', 'male'].includes(rawProfile.gender)) {
        throw new Error(t('profileLoadError'));
      }
      const p = {
        id: rawProfile.id.trim(),
        displayName: safeProfileText(rawProfile.displayName, 80).trim(),
        age: rawProfile.age,
        gender: rawProfile.gender,
        bio: safeProfileText(rawProfile.bio, 2000),
        country: safeProfileText(rawProfile.country, 100),
        city: safeProfileText(rawProfile.city, 100),
        occupation: safeProfileText(rawProfile.occupation, 120),
        education: safeProfileText(rawProfile.education, 120),
        relationshipIntent: safeProfileChoice(rawProfile.relationshipIntent, ['marriage_family', 'serious_relationship', 'family_without_marriage'] as const, 'marriage_family'),
        familyFormat: safeProfileChoice(rawProfile.familyFormat, ['marriage', 'cohabitation', 'open_to_both'] as const, 'open_to_both'),
        hasChildren: typeof rawProfile.hasChildren === 'boolean' ? rawProfile.hasChildren : null,
        wantsChildren: safeProfileChoice(rawProfile.wantsChildren, ['yes', 'no', 'discuss', 'unsure'] as const, 'discuss'),
        childrenLivingArrangement: safeProfileChoice(rawProfile.childrenLivingArrangement, ['with_me', 'shared_custody', 'with_other_parent', 'not_applicable', 'prefer_to_discuss'] as const, 'not_applicable'),
        childrenDisclosureConfirmedAt: typeof rawProfile.childrenDisclosureConfirmedAt === 'string' && rawProfile.childrenDisclosureConfirmedAt.length <= 100 ? rawProfile.childrenDisclosureConfirmedAt : null,
        isVisible: typeof rawProfile.isVisible === 'boolean' ? rawProfile.isVisible : true,
        photoUrls: Array.isArray(rawProfile.photoUrls)
          ? Array.from(new Set(rawProfile.photoUrls
              .slice(0, 100)
              .filter((value: unknown): value is string =>
                typeof value === 'string' &&
                value.trim().length > 0 &&
                value.trim().length <= 2048 &&
                !/[\u0000-\u001F\u007F]/.test(value) &&
                !value.includes('\\') &&
                (/^https?:\/\//i.test(value.trim()) || /^\/(?!\/)/.test(value.trim()))
              )
              .map((value: string) => value.trim()))).slice(0, 6)
          : [],
        languages: Array.isArray(rawProfile.languages)
          ? [...new Map(rawProfile.languages.slice(0, 100)
              .filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0)
              .map((value: string) => value.trim().slice(0, 50))
              .filter(Boolean)
              .map((value: string) => [value.toLowerCase(), value] as const)).values()].slice(0, 20)
          : []
      } as Profile;
      setProfile(p);
      setDisplayName(p.displayName);
      setBio(p.bio);
      setCountry(p.country);
      setCity(p.city);
      setOccupation(p.occupation);
      setEducation(p.education);
      setPhotoUrls((p.photoUrls || []).join('\n'));
      setLanguages((p.languages || []).join(', ').slice(0, 1000));
      setRelationshipIntent(p.relationshipIntent);
      setFamilyFormat(p.familyFormat || 'open_to_both');
      setHasChildren(typeof p.hasChildren === 'boolean' ? p.hasChildren : null);
      setWantsChildren(p.wantsChildren || 'discuss');
      setChildrenLivingArrangement(p.childrenLivingArrangement || 'not_applicable');
      setIsVisible(p.isVisible);
      setAuthenticated(true);
      const blocksResponse = await fetch('/api/blocks', { credentials: 'include' });
      if (requestId !== profileLoadRequestId.current) return;
      if (blocksResponse.ok) {
        const blockData = await blocksResponse.json();
        if (requestId !== profileLoadRequestId.current) return;
        const seenBlockedIds = new Set<string>();
        const safeBlocks = Array.isArray(blockData?.blocks)
          ? blockData.blocks.filter((block: unknown): block is BlockedProfile => {
              if (!block || typeof block !== 'object' || Array.isArray(block)) return false;
              const value = block as Partial<BlockedProfile>;
              if (typeof value.id !== 'string' || !value.id.trim() || value.id.trim().length > 256 ||
                  typeof value.displayName !== 'string' || !value.displayName.trim() || value.displayName.trim().length > 100 ||
                  typeof value.createdAt !== 'string' || !value.createdAt.trim() || value.createdAt.length > 100 ||
                  !Number.isFinite(Date.parse(value.createdAt.trim()))) return false;
              const id = value.id.trim();
              if (seenBlockedIds.has(id)) return false;
              seenBlockedIds.add(id);
              return true;
            }).slice(0, 200)
          : [];
        setBlockedProfiles(safeBlocks.map((block: BlockedProfile) => ({
          id: block.id.trim(),
          displayName: block.displayName.trim(),
          createdAt: block.createdAt.trim()
        })));
      }
    } catch (error) {
      if (requestId === profileLoadRequestId.current) {
        setNotice(error instanceof Error ? error.message : t('profileLoadError'));
      }
    }
  };
  useEffect(() => {
    void load();
    const refreshOnSession = () => {
      profileLoadRequestId.current += 1;
      setProfile(null);
      setDisplayName('');
      setBio('');
      setCountry('');
      setCity('');
      setOccupation('');
      setEducation('');
      setPhotoUrls('');
      setLanguages('');
      setRelationshipIntent('marriage_family');
      setFamilyFormat('open_to_both');
      setHasChildren(null);
      setWantsChildren('discuss');
      setChildrenLivingArrangement('not_applicable');
      setIsVisible(true);
      setAuthenticated(null);
      setBusy(false);
      setUploadBusy(false);
      setBlockedProfiles([]);
      unblockingIdsRef.current.clear();
      setUnblockingIds(new Set());
      setNotice('');
      void load();
    };
    window.addEventListener('vow:session-changed', refreshOnSession);
    return () => {
      window.removeEventListener('vow:session-changed', refreshOnSession);
      profileLoadRequestId.current += 1;
    };
  }, []);

  const unblock = async (id: string) => {
    if (unblockingIdsRef.current.has(id)) return;
    const requestId = profileLoadRequestId.current;
    unblockingIdsRef.current.add(id);
    setUnblockingIds(current => new Set(current).add(id));
    try {
      const response = await fetch(`/api/blocks/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' });
      if (requestId !== profileLoadRequestId.current) return;
      if (response.status === 401) {
        profileLoadRequestId.current += 1;
        setAuthenticated(false);
        setProfile(null);
        setDisplayName('');
        setBio('');
        setCountry('');
        setCity('');
        setOccupation('');
        setEducation('');
        setPhotoUrls('');
        setLanguages('');
        setRelationshipIntent('marriage_family');
        setFamilyFormat('open_to_both');
        setHasChildren(null);
        setWantsChildren('discuss');
        setChildrenLivingArrangement('not_applicable');
        setIsVisible(true);
        setBlockedProfiles([]);
        unblockingIdsRef.current.clear();
        setUnblockingIds(new Set());
        setBusy(false);
        setUploadBusy(false);
        setNotice('');
        return;
      }
      if (!response.ok) throw new Error(t('profileUnblockError'));
      setBlockedProfiles(current => current.filter(profile => profile.id !== id));
      setNotice(t('profileUnblocked'));
    } catch (error) {
      if (requestId === profileLoadRequestId.current) {
        setNotice(error instanceof Error ? error.message : t('profileUnblockError'));
      }
    } finally {
      unblockingIdsRef.current.delete(id);
      if (requestId === profileLoadRequestId.current) {
        setUnblockingIds(current => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    }
  };

  const save = async () => {
    const requestId = profileLoadRequestId.current;
    setBusy(true);
    setNotice('');
    try {
      const photos = [...new Set(photoUrls.split(/\n|,/).map(value => value.trim()).filter(Boolean))]
        .filter(value => value.length <= 2048 && !/[\u0000-\u001F\u007F]/.test(value) && !value.includes('\\') && (/^https?:\/\//i.test(value) || /^\/(?!\/)/.test(value)))
        .slice(0, 6);
      const languageList = [...new Map(languages.split(',')
        .slice(0, 100)
        .filter(value => value.trim().length > 0)
        .map(value => value.trim().slice(0, 50))
        .filter(Boolean)
        .map(value => [value.toLowerCase(), value] as const)).values()].slice(0, 20);
      const response = await fetch('/api/profiles/me', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName, bio, country, city, occupation, education,
          photoUrls: photos, languages: languageList, relationshipIntent, familyFormat, hasChildren, wantsChildren, childrenLivingArrangement, isVisible
        })
      });
      const data = await response.json().catch(() => null);
      if (requestId !== profileLoadRequestId.current) return;
      if (response.status === 401) {
        profileLoadRequestId.current += 1;
        setAuthenticated(false);
        setProfile(null);
        setDisplayName('');
        setBio('');
        setCountry('');
        setCity('');
        setOccupation('');
        setEducation('');
        setPhotoUrls('');
        setLanguages('');
        setRelationshipIntent('marriage_family');
        setFamilyFormat('open_to_both');
        setHasChildren(null);
        setWantsChildren('discuss');
        setChildrenLivingArrangement('not_applicable');
        setIsVisible(true);
        setBlockedProfiles([]);
        unblockingIdsRef.current.clear();
        setUnblockingIds(new Set());
        setBusy(false);
        setUploadBusy(false);
        setNotice('');
        return;
      }
      if (!response.ok) {
        const errors: Record<string, string> = {
          children_status_required: t('profileChildrenRequired'),
          invalid_family_format: t('profileInvalidFamilyFormat'),
          invalid_photo_urls: t('profileInvalidPhotoUrls'),
          invalid_languages: t('profileInvalidLanguages'),
          invalid_bio: t('profileInvalidBio')
        };
        throw new Error(errors[data?.error] || t('profileSaveError'));
      }
      const savedProfile = data?.profile;
      if (!savedProfile || typeof savedProfile !== 'object' || Array.isArray(savedProfile) ||
          typeof savedProfile.id !== 'string' || !savedProfile.id.trim() || savedProfile.id.trim().length > 256 ||
          typeof savedProfile.displayName !== 'string' || !savedProfile.displayName.trim() || savedProfile.displayName.trim().length > 80 ||
          typeof savedProfile.age !== 'number' || !Number.isFinite(savedProfile.age) || savedProfile.age < 18 || savedProfile.age > 120 ||
          !['female', 'male'].includes(savedProfile.gender)) {
        throw new Error(t('profileSaveError'));
      }
      setProfile({
        id: savedProfile.id.trim(),
        displayName: safeProfileText(savedProfile.displayName, 80).trim(),
        age: savedProfile.age,
        gender: savedProfile.gender,
        bio: safeProfileText(savedProfile.bio, 2000).trim(),
        country: safeProfileText(savedProfile.country, 100).trim(),
        city: safeProfileText(savedProfile.city, 100).trim(),
        occupation: safeProfileText(savedProfile.occupation, 120).trim(),
        education: safeProfileText(savedProfile.education, 120).trim(),
        relationshipIntent: safeProfileChoice(savedProfile.relationshipIntent, ['marriage_family', 'serious_relationship', 'family_without_marriage'] as const, 'marriage_family'),
        familyFormat: safeProfileChoice(savedProfile.familyFormat, ['marriage', 'cohabitation', 'open_to_both'] as const, 'open_to_both'),
        hasChildren: typeof savedProfile.hasChildren === 'boolean' ? savedProfile.hasChildren : null,
        wantsChildren: safeProfileChoice(savedProfile.wantsChildren, ['yes', 'no', 'discuss', 'unsure'] as const, 'discuss'),
        childrenLivingArrangement: safeProfileChoice(savedProfile.childrenLivingArrangement, ['with_me', 'shared_custody', 'with_other_parent', 'not_applicable', 'prefer_to_discuss'] as const, 'not_applicable'),
        childrenDisclosureConfirmedAt: typeof savedProfile.childrenDisclosureConfirmedAt === 'string' && savedProfile.childrenDisclosureConfirmedAt.length <= 100 ? savedProfile.childrenDisclosureConfirmedAt : null,
        isVisible: typeof savedProfile.isVisible === 'boolean' ? savedProfile.isVisible : true,
        photoUrls: Array.isArray(savedProfile.photoUrls)
          ? Array.from(new Set(savedProfile.photoUrls
              .slice(0, 100)
              .filter((value: unknown): value is string =>
                typeof value === 'string' &&
                value.trim().length > 0 &&
                value.trim().length <= 2048 &&
                !/[\u0000-\u001F\u007F]/.test(value) &&
                !value.includes('\\') &&
                (/^https?:\/\//i.test(value.trim()) || /^\/(?!\/)/.test(value.trim()))
              )
              .map((value: string) => value.trim()))).slice(0, 6)
          : [],
        languages: Array.isArray(savedProfile.languages)
          ? [...new Map(savedProfile.languages.slice(0, 100)
              .filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0)
              .map((value: string) => value.trim().slice(0, 50))
              .filter(Boolean)
              .map((value: string) => [value.toLowerCase(), value] as const)).values()].slice(0, 20)
          : []
      } as Profile);
      setNotice(t('profileSaved'));
    } catch (error) {
      if (requestId === profileLoadRequestId.current) {
        setNotice(error instanceof Error ? error.message : t('profileSaveError'));
      }
    } finally {
      if (requestId === profileLoadRequestId.current) setBusy(false);
    }
  };

  return (
    <section aria-busy={busy || uploadBusy} className="vow-screen vow-profile-editor-panel mb-5 min-w-0 rounded-3xl border border-amber-500/20 bg-stone-900/80 p-3 sm:p-5">
      <p className="text-[10px] uppercase tracking-[0.2em] text-amber-300">{t('profileMyProfile')}</p>
      <h3 className="mt-1 text-lg font-bold text-white">{t('profileHeading')}</h3>
      {authenticated === false ? (
        <div className="mt-3 rounded-2xl border border-white/10 bg-stone-950/60 p-4">
          <p className="text-sm text-stone-300">{t('profileLoginPrompt')}</p>
          <button type="button" onClick={onOpenAccount} className="mt-3 rounded-xl bg-rose-600 px-4 py-2.5 text-xs font-bold text-white">{t('profileLoginButton')}</button>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {profile && <p className="text-xs text-stone-500">{profile.age} {t('profileAgeSuffix')} · {profile.gender === 'female' ? t('profileGenderFemale') : t('profileGenderMale')} · {t('profileServerOnlyId')}</p>}
          <label className="block text-xs text-stone-300">{t('profileName')}<input value={displayName} onChange={e => setDisplayName(e.target.value)} maxLength={80} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400" /></label>
          <label className="block text-xs text-stone-300">{t('profileAbout')}<textarea value={bio} onChange={e => setBio(e.target.value)} maxLength={2000} rows={4} placeholder={t('profileBioPlaceholder')} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400" /></label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="block text-xs text-stone-300">{t('profileCountry')}<input value={country} onChange={e => setCountry(e.target.value)} maxLength={100} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400" /></label>
            <label className="block text-xs text-stone-300">{t('profileCity')}<input value={city} onChange={e => setCity(e.target.value)} maxLength={100} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400" /></label>
            <label className="block text-xs text-stone-300">{t('profileOccupation')}<input value={occupation} onChange={e => setOccupation(e.target.value)} maxLength={120} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400" /></label>
            <label className="block text-xs text-stone-300">{t('profileEducation')}<input value={education} onChange={e => setEducation(e.target.value)} maxLength={120} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400" /></label>
          </div>
          <label className="block text-xs text-stone-300">{t('profileLanguages')}<input value={languages} maxLength={1000} onChange={e => setLanguages(e.target.value.slice(0, 1000))} placeholder={t('profileLanguagesPlaceholder')} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400" /></label>
          <label className="block text-xs text-stone-300">{t('profileUploadPhoto')}
            <input type="file" accept="image/jpeg,image/png" disabled={busy || uploadBusy || (photoUrls.split(/\n|,/).map(value => value.trim()).filter(Boolean).length >= 6)} onChange={async event => {
              const file=event.currentTarget.files?.[0]; event.currentTarget.value=''; if(!file)return;
              if(!['image/jpeg','image/png'].includes(file.type)||file.size>8*1024*1024){setNotice(t('profileInvalidPhotoFile'));return;}
              const requestId = profileLoadRequestId.current;
              setUploadBusy(true);setNotice('');
              try {
                const response=await fetch('/api/photos',{method:'POST',credentials:'include',headers:{'Content-Type':file.type},body:file});
                const data=await response.json().catch(()=>null);
                if (requestId !== profileLoadRequestId.current) return;
                if (response.status === 401) {
                  profileLoadRequestId.current += 1;
                  setAuthenticated(false);
                  setProfile(null);
                  setDisplayName('');
                  setBio('');
                  setCountry('');
                  setCity('');
                  setOccupation('');
                  setEducation('');
                  setPhotoUrls('');
                  setLanguages('');
                  setRelationshipIntent('marriage_family');
                  setFamilyFormat('open_to_both');
                  setHasChildren(null);
                  setWantsChildren('discuss');
                  setChildrenLivingArrangement('not_applicable');
                  setIsVisible(true);
                  setBlockedProfiles([]);
                  unblockingIdsRef.current.clear();
                  setUnblockingIds(new Set());
                  setBusy(false);
                  setUploadBusy(false);
                  setNotice('');
                  return;
                }
                if(!response.ok) throw new Error(data?.error==='photo_limit_reached'?t('profilePhotoLimit'):data?.error==='photo_storage_not_configured'?t('profilePhotoStorageError'):data?.error==='photo_rejected_by_automated_review'?t('profilePhotoRejected'):t('profilePhotoUploadError'));
                if (typeof data?.photoUrl !== 'string' || data.photoUrl.trim().length === 0 || data.photoUrl.trim().length > 2048 || /[\u0000-\u001F\u007F]/.test(data.photoUrl) || data.photoUrl.includes('\\') || !(/^https?:\/\//i.test(data.photoUrl.trim()) || /^\/(?!\/)/.test(data.photoUrl.trim()))) throw new Error(t('profilePhotoUploadError'));
                setPhotoUrls(current => {
                  const existing = [...new Set(current.split(/\n|,/).map(value => value.trim()).filter(Boolean))];
                  const uploadedUrl = data.photoUrl.trim();
                  if (existing.includes(uploadedUrl) || existing.length >= 6) return existing.join('\n');
                  return [...existing, uploadedUrl].join('\n');
                });
                setNotice(data.reviewStatus==='approved'?t('profilePhotoApproved'): t('profilePhotoPending'));
              } catch(error){if(requestId===profileLoadRequestId.current)setNotice(error instanceof Error?error.message:t('profilePhotoUploadError'));}
              finally{if(requestId===profileLoadRequestId.current)setUploadBusy(false);}
            }} className="mt-2 block w-full text-sm text-stone-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 file:me-3 file:rounded-lg file:border-0 file:bg-rose-700 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-white" />
          </label>
          <label className="block text-xs text-stone-300">{t('profileUploadedPhotos')}<textarea value={photoUrls} readOnly rows={3} placeholder={t('profilePhotosPlaceholder')} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white read-only:opacity-80" /></label>
          {photoUrls.split(/\n|,/).map(value => value.trim()).filter(Boolean).length > 0 && <button type="button" disabled={busy || uploadBusy} onClick={() => setPhotoUrls(current => current.split(/\n|,/).map(value => value.trim()).filter(Boolean).slice(0, -1).join("\n"))} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-stone-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:cursor-not-allowed disabled:opacity-50" >{t('profileRemoveLastPhoto')}</button>}
          <p className="text-[10px] leading-relaxed text-stone-500">{t('profilePhotoPrivacyNote')}</p>
          <label className="block text-xs text-stone-300">{t('profileRelationshipGoal')}<select value={relationshipIntent} onChange={e => setRelationshipIntent(e.target.value as typeof relationshipIntent)} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"><option value="marriage_family">{t('profileGoalMarriage')}</option><option value="family_without_marriage">{t('profileGoalFamilyNoMarriage')}</option><option value="serious_relationship">{t('profileGoalSerious')}</option></select></label>
          <label className="block text-xs text-stone-300">{t('profileFamilyFormat')}<select value={familyFormat} onChange={e => setFamilyFormat(e.target.value as typeof familyFormat)} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"><option value="open_to_both">{t('profileFamilyBoth')}</option><option value="marriage">{t('profileFamilyMarriage')}</option><option value="cohabitation">{t('profileFamilyCohabitation')}</option></select></label>
          <fieldset className="rounded-xl border border-white/10 bg-stone-950 p-3">
            <legend className="px-1 text-xs font-semibold text-white">{t('profileHasChildrenRequired')}</legend>
            <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
              <button type="button" aria-pressed={hasChildren === true} onClick={() => {setHasChildren(true);setChildrenLivingArrangement('prefer_to_discuss');}} className={`rounded-lg border p-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 ${hasChildren === true ? 'border-rose-500 bg-rose-950 text-white' : 'border-white/10 text-stone-300'}`}>{t('yes')}</button>
              <button type="button" aria-pressed={hasChildren === false} onClick={() => {setHasChildren(false);setChildrenLivingArrangement('not_applicable');}} className={`rounded-lg border p-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 ${hasChildren === false ? 'border-rose-500 bg-rose-950 text-white' : 'border-white/10 text-stone-300'}`}>{t('no')}</button>
            </div>
            {hasChildren === true && <label className="mt-3 block text-xs text-stone-300">{t('profileChildrenLiving')}<select value={childrenLivingArrangement} onChange={e => setChildrenLivingArrangement(e.target.value as typeof childrenLivingArrangement)} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"><option value="with_me">{t('profileChildrenWithMe')}</option><option value="shared_custody">{t('profileChildrenSharedCustody')}</option><option value="with_other_parent">{t('profileChildrenOtherParent')}</option><option value="prefer_to_discuss">{t('profileDiscussInPerson')}</option></select></label>}
            <label className="mt-3 block text-xs text-stone-300">{t('profileWantChildren')}<select value={wantsChildren} onChange={e => setWantsChildren(e.target.value as typeof wantsChildren)} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"><option value="yes">{t('yes')}</option><option value="no">{t('no')}</option><option value="discuss">{t('profileDiscussWithPartner')}</option><option value="unsure">{t('profileUnsure')}</option></select></label>
            {profile?.childrenDisclosureConfirmedAt === null && <p className="mt-2 text-[10px] text-amber-300">{t('profileConfirmChildrenNotice')}</p>}
          </fieldset>
          <label className="flex items-center gap-3 rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-stone-200"><input type="checkbox" checked={isVisible} onChange={e => setIsVisible(e.target.checked)} className="h-4 w-4 rounded accent-rose-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400" />{t('profileShowInSearch')}</label>
          <button type="button" onClick={() => void save()} disabled={busy || uploadBusy || !displayName.trim() || !country.trim() || !city.trim() || hasChildren === null} className="w-full rounded-xl bg-amber-700 px-4 py-3 text-sm font-bold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:cursor-not-allowed disabled:opacity-50">{busy ? t('profileSaving') : t('profileSave')}</button>
          <div className="rounded-2xl border border-white/10 bg-stone-950/60 p-3">
            <h4 className="text-sm font-semibold text-white">{t('profileBlockedUsers')}</h4>
            {!blockedProfiles.length ? <p className="mt-2 text-xs text-stone-500">{t('profileBlockListEmpty')}</p> : blockedProfiles.map(blocked => (
              <div key={blocked.id} className="mt-2 flex items-center justify-between gap-3 rounded-xl border border-white/10 p-2">
                <span className="truncate text-xs text-stone-300">{blocked.displayName}</span>
                <button type="button" aria-label={`${t('profileUnblock')}: ${blocked.displayName}`} onClick={() => void unblock(blocked.id)} disabled={unblockingIds.has(blocked.id)} className="shrink-0 rounded-lg border border-white/10 px-2 py-1.5 text-[10px] text-stone-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:cursor-not-allowed disabled:opacity-50">{t('profileUnblock')}</button>
              </div>
            ))}
          </div>
        </div>
      )}
      {notice && <p role="status" aria-live="polite" className="mt-3 text-xs text-stone-300">{notice}</p>}
    </section>
  );
};
