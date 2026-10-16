import React, { useEffect, useState } from 'react';

type Profile = {
  id: string; displayName: string; age: number; gender: 'female' | 'male';
  country: string; city: string; bio: string; photoUrls: string[];
  occupation: string; education: string; languages: string[];
  relationshipIntent: 'marriage_family' | 'serious_relationship'; isVisible: boolean;
};
type BlockedProfile = { id: string; displayName: string; createdAt: string };
type Props = { onOpenAccount: () => void };

export const ProfileEditorPanel: React.FC<Props> = ({ onOpenAccount }) => {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [country, setCountry] = useState('');
  const [city, setCity] = useState('');
  const [occupation, setOccupation] = useState('');
  const [education, setEducation] = useState('');
  const [photoUrls, setPhotoUrls] = useState('');
  const [languages, setLanguages] = useState('');
  const [relationshipIntent, setRelationshipIntent] = useState<'marriage_family' | 'serious_relationship'>('marriage_family');
  const [isVisible, setIsVisible] = useState(true);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [blockedProfiles, setBlockedProfiles] = useState<BlockedProfile[]>([]);

  const load = async () => {
    try {
      const response = await fetch('/api/profiles/me', { credentials: 'include' });
      if (response.status === 401) { setAuthenticated(false); return; }
      if (!response.ok) throw new Error('Не удалось загрузить профиль.');
      const data = await response.json();
      const p = data.profile as Profile;
      setProfile(p);
      setDisplayName(p.displayName || '');
      setBio(p.bio || '');
      setCountry(p.country || '');
      setCity(p.city || '');
      setOccupation(p.occupation || '');
      setEducation(p.education || '');
      setPhotoUrls((p.photoUrls || []).join('\n'));
      setLanguages((p.languages || []).join(', '));
      setRelationshipIntent(p.relationshipIntent);
      setIsVisible(p.isVisible);
      setAuthenticated(true);
      const blocksResponse = await fetch('/api/blocks', { credentials: 'include' });
      if (blocksResponse.ok) {
        const blockData = await blocksResponse.json();
        setBlockedProfiles(blockData.blocks || []);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Ошибка загрузки профиля.');
    }
  };
  useEffect(() => { void load(); }, []);

  const unblock = async (id: string) => {
    try {
      const response = await fetch(`/api/blocks/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' });
      if (!response.ok) throw new Error('Не удалось разблокировать пользователя.');
      setBlockedProfiles(current => current.filter(profile => profile.id !== id));
      setNotice('Пользователь разблокирован. Его анкета может снова появиться в поиске.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Ошибка разблокировки.');
    }
  };

  const save = async () => {
    setBusy(true);
    setNotice('');
    try {
      const photos = photoUrls.split(/\n|,/).map(value => value.trim()).filter(Boolean);
      const languageList = languages.split(',').map(value => value.trim()).filter(Boolean);
      const response = await fetch('/api/profiles/me', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName, bio, country, city, occupation, education,
          photoUrls: photos, languages: languageList, relationshipIntent, isVisible
        })
      });
      const data = await response.json().catch(() => null);
      if (response.status === 401) { setAuthenticated(false); return; }
      if (!response.ok) {
        const errors: Record<string, string> = {
          invalid_photo_urls: 'Фотографии должны быть HTTPS-ссылками без логина и пароля; максимум 6.',
          invalid_languages: 'Укажите не более 10 языков, каждый от 2 до 40 символов.',
          invalid_bio: 'Описание не должно превышать 2000 символов.'
        };
        throw new Error(errors[data?.error] || 'Не удалось сохранить профиль. Проверьте поля.');
      }
      setProfile(data.profile);
      setNotice('Профиль сохранён.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Ошибка сохранения.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mb-5 rounded-3xl border border-amber-500/20 bg-stone-900/80 p-4 sm:p-5">
      <p className="text-[10px] uppercase tracking-[0.2em] text-amber-300">Моя анкета</p>
      <h3 className="mt-1 text-lg font-bold text-white">Профиль для серьёзных отношений</h3>
      {authenticated === false ? (
        <div className="mt-3 rounded-2xl border border-white/10 bg-stone-950/60 p-4">
          <p className="text-sm text-stone-300">Войдите, чтобы редактировать анкету.</p>
          <button type="button" onClick={onOpenAccount} className="mt-3 rounded-xl bg-rose-600 px-4 py-2.5 text-xs font-bold text-white">Вход и регистрация</button>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {profile && <p className="text-xs text-stone-500">{profile.age} лет · {profile.gender === 'female' ? 'Женский' : 'Мужской'} · ID профиля доступен только серверу</p>}
          <label className="block text-xs text-stone-300">Имя<input value={displayName} onChange={e => setDisplayName(e.target.value)} maxLength={80} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white" /></label>
          <label className="block text-xs text-stone-300">О себе<textarea value={bio} onChange={e => setBio(e.target.value)} maxLength={2000} rows={4} placeholder="Что важно знать о вас и ваших намерениях?" className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white" /></label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-stone-300">Страна<input value={country} onChange={e => setCountry(e.target.value)} maxLength={100} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white" /></label>
            <label className="block text-xs text-stone-300">Город<input value={city} onChange={e => setCity(e.target.value)} maxLength={120} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white" /></label>
            <label className="block text-xs text-stone-300">Профессия<input value={occupation} onChange={e => setOccupation(e.target.value)} maxLength={120} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white" /></label>
            <label className="block text-xs text-stone-300">Образование<input value={education} onChange={e => setEducation(e.target.value)} maxLength={120} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white" /></label>
          </div>
          <label className="block text-xs text-stone-300">Языки через запятую<input value={languages} onChange={e => setLanguages(e.target.value)} placeholder="Русский, английский" className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white" /></label>
          <label className="block text-xs text-stone-300">HTTPS-ссылки на фотографии (до 6, по одной в строке)<textarea value={photoUrls} onChange={e => setPhotoUrls(e.target.value)} rows={3} placeholder="https://example.com/photo.jpg" className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white" /></label>
          <p className="text-[10px] leading-relaxed text-stone-500">Это пока ссылки, не загрузка файлов. Не используйте чужие фотографии без разрешения; HTTPS-ссылка сама по себе не подтверждает личность.</p>
          <label className="block text-xs text-stone-300">Намерение<select value={relationshipIntent} onChange={e => setRelationshipIntent(e.target.value as 'marriage_family' | 'serious_relationship')} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white"><option value="marriage_family">Брак и семья</option><option value="serious_relationship">Серьёзные отношения</option></select></label>
          <label className="flex items-center gap-3 rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-stone-200"><input type="checkbox" checked={isVisible} onChange={e => setIsVisible(e.target.checked)} className="h-4 w-4 accent-rose-500" />Показывать анкету в поиске</label>
          <button type="button" onClick={() => void save()} disabled={busy || !displayName.trim() || !country.trim() || !city.trim()} className="w-full rounded-xl bg-amber-700 px-4 py-3 text-sm font-bold text-white disabled:opacity-50">{busy ? 'Сохраняем…' : 'Сохранить анкету'}</button>
          <div className="rounded-2xl border border-white/10 bg-stone-950/60 p-3">
            <h4 className="text-sm font-semibold text-white">Заблокированные пользователи</h4>
            {!blockedProfiles.length ? <p className="mt-2 text-xs text-stone-500">Список пуст.</p> : blockedProfiles.map(blocked => (
              <div key={blocked.id} className="mt-2 flex items-center justify-between gap-3 rounded-xl border border-white/10 p-2">
                <span className="truncate text-xs text-stone-300">{blocked.displayName}</span>
                <button type="button" onClick={() => void unblock(blocked.id)} className="shrink-0 rounded-lg border border-white/10 px-2 py-1.5 text-[10px] text-stone-300">Разблокировать</button>
              </div>
            ))}
          </div>
        </div>
      )}
      {notice && <p role="status" className="mt-3 text-xs text-stone-300">{notice}</p>}
    </section>
  );
};
