import React, { useEffect, useState } from 'react';

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
      setFamilyFormat(p.familyFormat || 'open_to_both');
      setHasChildren(typeof p.hasChildren === 'boolean' ? p.hasChildren : null);
      setWantsChildren(p.wantsChildren || 'discuss');
      setChildrenLivingArrangement(p.childrenLivingArrangement || 'not_applicable');
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
          photoUrls: photos, languages: languageList, relationshipIntent, familyFormat, hasChildren, wantsChildren, childrenLivingArrangement, isVisible
        })
      });
      const data = await response.json().catch(() => null);
      if (response.status === 401) { setAuthenticated(false); return; }
      if (!response.ok) {
        const errors: Record<string, string> = {
          children_status_required: 'Обязательно укажите, есть ли у вас дети.',
          invalid_family_format: 'Проверьте формат семьи.',
          invalid_photo_urls: 'Можно использовать только фотографии, загруженные через безопасную форму; максимум 6.',
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
    <section className="vow-screen mb-5 min-w-0 rounded-3xl border border-amber-500/20 bg-stone-900/80 p-3 sm:p-5">
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
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="block text-xs text-stone-300">Страна<input value={country} onChange={e => setCountry(e.target.value)} maxLength={100} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white" /></label>
            <label className="block text-xs text-stone-300">Город<input value={city} onChange={e => setCity(e.target.value)} maxLength={120} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white" /></label>
            <label className="block text-xs text-stone-300">Профессия<input value={occupation} onChange={e => setOccupation(e.target.value)} maxLength={120} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white" /></label>
            <label className="block text-xs text-stone-300">Образование<input value={education} onChange={e => setEducation(e.target.value)} maxLength={120} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white" /></label>
          </div>
          <label className="block text-xs text-stone-300">Языки через запятую<input value={languages} onChange={e => setLanguages(e.target.value)} placeholder="Русский, английский" className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white" /></label>
          <label className="block text-xs text-stone-300">Загрузить фотографию (JPEG или PNG, до 8 МБ)
            <input type="file" accept="image/jpeg,image/png" disabled={uploadBusy || (photoUrls.split(/\n|,/).map(value => value.trim()).filter(Boolean).length >= 6)} onChange={async event => {
              const file=event.currentTarget.files?.[0]; event.currentTarget.value=''; if(!file)return;
              if(!['image/jpeg','image/png'].includes(file.type)||file.size>8*1024*1024){setNotice('Выберите JPEG или PNG размером не более 8 МБ.');return;}
              setUploadBusy(true);setNotice('');
              try {
                const response=await fetch('/api/photos',{method:'POST',credentials:'include',headers:{'Content-Type':file.type},body:file});
                const data=await response.json().catch(()=>null);
                if(!response.ok) throw new Error(data?.error==='photo_limit_reached'?'Можно добавить не более 6 фотографий.':data?.error==='photo_storage_not_configured'?'На сервере не настроено постоянное хранилище фотографий.':data?.error==='photo_rejected_by_automated_review'?'Автоматическая проверка отклонила изображение. Выберите другую фотографию.':'Не удалось загрузить фото. Проверьте подключение и настройки хранилища.');
                setPhotoUrls(current=>[...current.split(/\n|,/).map(value=>value.trim()).filter(Boolean),data.photoUrl].join('\n'));
                setNotice(data.reviewStatus==='approved'?'Фото прошло автоматическую предварительную проверку и загружено.': 'Фото загружено и ожидает проверки модератором. После одобрения оно станет доступно в поиске.');
              } catch(error){setNotice(error instanceof Error?error.message:'Ошибка загрузки фотографии.');}
              finally{setUploadBusy(false);}
            }} className="mt-2 block w-full text-sm text-stone-300 file:me-3 file:rounded-lg file:border-0 file:bg-rose-700 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-white" />
          </label>
          <label className="block text-xs text-stone-300">Загруженные фотографии (до 6 всего)<textarea value={photoUrls} readOnly rows={3} placeholder="Загрузите фото через форму выше" className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white read-only:opacity-80" /></label>
          {photoUrls.split(/\n|,/).map(value => value.trim()).filter(Boolean).length > 0 && <button type="button" onClick={() => setPhotoUrls(current => current.split(/\n|,/).map(value => value.trim()).filter(Boolean).slice(0, -1).join("\n"))} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-stone-300">Убрать последнюю фотографию</button>}
          <p className="text-[10px] leading-relaxed text-stone-500">При загрузке JPEG/PNG декодируются и повторно кодируются; EXIF и другие метаданные удаляются. Если локальная ИИ-проверка включена, очевидно безопасное фото может быть одобрено автоматически; неоднозначные снимки остаются скрытыми до проверки модератором. Не загружайте чужие фото без разрешения.</p>
          <label className="block text-xs text-stone-300">Цель отношений<select value={relationshipIntent} onChange={e => setRelationshipIntent(e.target.value as typeof relationshipIntent)} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white"><option value="marriage_family">Брак и семья</option><option value="family_without_marriage">Семья без регистрации брака</option><option value="serious_relationship">Серьёзные отношения</option></select></label>
          <label className="block text-xs text-stone-300">Формат семьи<select value={familyFormat} onChange={e => setFamilyFormat(e.target.value as typeof familyFormat)} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white"><option value="open_to_both">Открыт(а) к обоим форматам</option><option value="marriage">Только официальный брак</option><option value="cohabitation">Совместная жизнь без брака</option></select></label>
          <fieldset className="rounded-xl border border-white/10 bg-stone-950 p-3">
            <legend className="px-1 text-xs font-semibold text-white">Есть ли у вас дети? Обязательно</legend>
            <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
              <button type="button" onClick={() => {setHasChildren(true);setChildrenLivingArrangement('prefer_to_discuss');}} className={`rounded-lg border p-2 text-xs ${hasChildren === true ? 'border-rose-500 bg-rose-950 text-white' : 'border-white/10 text-stone-300'}`}>Да</button>
              <button type="button" onClick={() => {setHasChildren(false);setChildrenLivingArrangement('not_applicable');}} className={`rounded-lg border p-2 text-xs ${hasChildren === false ? 'border-rose-500 bg-rose-950 text-white' : 'border-white/10 text-stone-300'}`}>Нет</button>
            </div>
            {hasChildren === true && <label className="mt-3 block text-xs text-stone-300">Где живут дети?<select value={childrenLivingArrangement} onChange={e => setChildrenLivingArrangement(e.target.value as typeof childrenLivingArrangement)} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white"><option value="with_me">Со мной</option><option value="shared_custody">Совместная опека / по очереди</option><option value="with_other_parent">С другим родителем</option><option value="prefer_to_discuss">Обсудить лично</option></select></label>}
            <label className="mt-3 block text-xs text-stone-300">Дети в будущем?<select value={wantsChildren} onChange={e => setWantsChildren(e.target.value as typeof wantsChildren)} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white"><option value="yes">Да</option><option value="no">Нет</option><option value="discuss">Обсуждать с партнёром</option><option value="unsure">Не уверен(а)</option></select></label>
            {profile?.childrenDisclosureConfirmedAt === null && <p className="mt-2 text-[10px] text-amber-300">Подтвердите информацию о детях и сохраните анкету, чтобы снова стать видимым в поиске.</p>}
          </fieldset>
          <label className="flex items-center gap-3 rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-stone-200"><input type="checkbox" checked={isVisible} onChange={e => setIsVisible(e.target.checked)} className="h-4 w-4 accent-rose-500" />Показывать анкету в поиске</label>
          <button type="button" onClick={() => void save()} disabled={busy || uploadBusy || !displayName.trim() || !country.trim() || !city.trim() || hasChildren === null} className="w-full rounded-xl bg-amber-700 px-4 py-3 text-sm font-bold text-white disabled:opacity-50">{busy ? 'Сохраняем…' : 'Сохранить анкету'}</button>
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
