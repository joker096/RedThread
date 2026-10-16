import React, { useCallback, useEffect, useRef, useState } from 'react';

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
};

type ServerDiscoveryPanelProps = { onOpenAccount: () => void };

export const ServerDiscoveryPanel: React.FC<ServerDiscoveryPanelProps> = ({ onOpenAccount }) => {
  const [profiles, setProfiles] = useState<ServerProfile[]>([]);
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
  const [notice, setNotice] = useState('');
  const [likedIds, setLikedIds] = useState<string[]>([]);
  const [blockedIds, setBlockedIds] = useState<string[]>([]);
  const [reportTargetId, setReportTargetId] = useState<string | null>(null);
  const [reportCategory, setReportCategory] = useState('fake_profile');
  const [reportDetails, setReportDetails] = useState('');
  const [swipeMode, setSwipeMode] = useState(false);
  const touchStartX = useRef<number | null>(null);

  const search = useCallback(async () => {
    setBusy(true);
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
    try {
      const response = await fetch(`/api/profiles/search?${params.toString()}`, { credentials: 'include' });
      if (response.status === 401) {
        setAuthenticated(false);
        setProfiles([]);
        return;
      }
      if (response.status === 402) {
        const data = await response.json().catch(() => null);
        setProfiles([]);
        setAuthenticated(true);
        setNotice(data?.message || 'Пробный период завершён. Для платных функций потребуется Premium.');
        return;
      }
      if (!response.ok) throw new Error('Не удалось выполнить поиск. Проверьте, что сервер настроен и миграции применены.');
      const data = await response.json();
      setProfiles(data.profiles || []);
      setAuthenticated(true);
      setNotice(data.profiles?.length ? `Найдено анкет: ${data.profiles.length}` : 'Подходящих анкет пока нет. Попробуйте изменить фильтры.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Не удалось подключиться к серверу.');
    } finally {
      setBusy(false);
    }
  }, [minAge, maxAge, minFinancialAlignment, country, city, intent, familyFormat, childrenFilter]);

  useEffect(() => { void search(); }, [search]);

  const like = async (profile: ServerProfile) => {
    if (busy) return;
    try {
      const response = await fetch(`/api/likes/${encodeURIComponent(profile.id)}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await response.json().catch(() => null);
      if (response.status === 401) {
        setAuthenticated(false);
        setNotice('Войдите в аккаунт, чтобы отправлять симпатии.');
        return;
      }
      if (response.status === 402) throw new Error(data?.message || 'Пробный период завершён. Для симпатий потребуется Premium; оплата ещё не подключена.');
      if (!response.ok) throw new Error('Не удалось отправить симпатию.');
      setLikedIds(current => current.includes(profile.id) ? current : [...current, profile.id]);
      setNotice(data?.matched ? `У вас взаимная симпатия с ${profile.displayName}! Совпадение создано.` : `Симпатия отправлена анкете «${profile.displayName}».`);
      if (swipeMode) setProfiles(current => current.filter(item => item.id !== profile.id));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Не удалось отправить симпатию.');
    }
  };

  const pass = async (profile: ServerProfile) => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/passes/${encodeURIComponent(profile.id)}`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
      });
      const data = await response.json().catch(() => null);
      if (response.status === 401) {
        setAuthenticated(false);
        setNotice('Войдите в аккаунт, чтобы управлять подбором.');
        return;
      }
      if (response.status === 402) throw new Error(data?.message || 'Пробный период завершён. Для пропуска анкет потребуется Premium.');
      if (!response.ok) throw new Error('Не удалось пропустить анкету.');
      setProfiles(current => current.filter(item => item.id !== profile.id));
      setNotice('Анкета пропущена и больше не будет показываться в поиске.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Ошибка пропуска анкеты.');
    } finally {
      setBusy(false);
    }
  };

  const submitReport = async (profile: ServerProfile) => {
    setBusy(true);
    try {
      const response = await fetch('/api/reports', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportedUserId: profile.id, category: reportCategory, details: reportDetails.trim() })
      });
      const data = await response.json().catch(() => null);
      if (response.status === 401) {
        setAuthenticated(false);
        setNotice('Войдите, чтобы отправить жалобу.');
        return;
      }
      if (!response.ok) throw new Error(data?.error === 'invalid_report_details' ? 'Проверьте категорию и длину комментария.' : 'Не удалось отправить жалобу.');
      setReportTargetId(null);
      setReportDetails('');
      setNotice('Жалоба отправлена на рассмотрение. Спасибо, что помогаете поддерживать безопасность.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Ошибка отправки жалобы.');
    } finally {
      setBusy(false);
    }
  };

  const block = async (profile: ServerProfile) => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/blocks/${encodeURIComponent(profile.id)}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      if (response.status === 401) {
        setAuthenticated(false);
        setNotice('Войдите, чтобы заблокировать пользователя.');
        return;
      }
      if (!response.ok) throw new Error('Не удалось заблокировать пользователя.');
      setBlockedIds(current => [...current, profile.id]);
      setProfiles(current => current.filter(item => item.id !== profile.id));
      setNotice(`Анкета «${profile.displayName}» заблокирована и больше не будет показываться вам.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Ошибка блокировки.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mb-5 rounded-3xl border border-emerald-500/20 bg-stone-900/80 p-4 sm:p-5">
      <div className="mb-3">
        <p className="text-[10px] uppercase tracking-[0.2em] text-emerald-300">Серверный поиск</p>
        <h3 className="mt-1 text-lg font-bold text-white">Анкеты из базы аккаунтов</h3>
        <p className="mt-1 text-xs leading-relaxed text-stone-400">Показываются реальные зарегистрированные аккаунты, подходящие под фильтры. Это отдельная выдача: демонстрационные карточки ниже не являются реальными пользователями.</p>
      </div>
      {authenticated === false ? (
        <div className="rounded-2xl border border-white/10 bg-stone-950/60 p-4">
          <p className="text-sm text-stone-200">Чтобы искать зарегистрированные анкеты и отправлять симпатии, войдите или создайте аккаунт.</p>
          <button type="button" onClick={onOpenAccount} className="mt-3 rounded-xl bg-rose-600 px-4 py-2.5 text-xs font-bold text-white">Вход и регистрация</button>
        </div>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-2">
            <label className="text-xs text-stone-300">Страна<input value={country} onChange={e => setCountry(e.target.value)} placeholder="Любая страна" className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-2.5 text-sm text-white" /></label>
            <label className="text-xs text-stone-300">Город<input value={city} onChange={e => setCity(e.target.value)} placeholder="Любой город" className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-2.5 text-sm text-white" /></label>
            <label className="text-xs text-stone-300">Возраст от<input type="number" min="18" max={maxAge} value={minAge} onChange={e => setMinAge(Math.min(maxAge, Math.max(18, Number(e.target.value) || 18)))} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-2.5 text-sm text-white" /></label>
            <label className="text-xs text-stone-300">Возраст до<input type="number" min={minAge} max="120" value={maxAge} onChange={e => setMaxAge(Math.max(minAge, Math.min(120, Number(e.target.value) || minAge)))} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-2.5 text-sm text-white" /></label>
            <label className="text-xs text-stone-300">Цель отношений<select value={intent} onChange={e => setIntent(e.target.value)} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-2.5 text-sm text-white"><option value="all">Любая</option><option value="marriage_family">Брак и семья</option><option value="family_without_marriage">Семья без регистрации брака</option><option value="serious_relationship">Серьёзные отношения</option></select></label>
            <label className="text-xs text-stone-300">Формат семьи<select value={familyFormat} onChange={e => setFamilyFormat(e.target.value)} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-2.5 text-sm text-white"><option value="all">Любой формат</option><option value="marriage">Только брак</option><option value="cohabitation">Совместная жизнь без регистрации</option><option value="open_to_both">Открыт(а) к обоим</option></select></label>
            <label className="text-xs text-stone-300">Наличие детей<select value={childrenFilter} onChange={e => setChildrenFilter(e.target.value)} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-2.5 text-sm text-white"><option value="all">Не важно</option><option value="false">Детей нет</option><option value="true">Есть дети</option></select></label>
            <label className="text-xs text-stone-300">Совпадение финансовых ожиданий<select value={minFinancialAlignment} onChange={e => setMinFinancialAlignment(Number(e.target.value))} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-2.5 text-sm text-white"><option value="0">Не фильтровать</option><option value="33">От 33%</option><option value="67">От 67%</option><option value="100">Только 100%</option></select></label>
          </div>
          <button type="button" onClick={() => void search()} disabled={busy} className="mb-2 w-full rounded-xl bg-emerald-700 px-4 py-3 text-sm font-bold text-white disabled:opacity-50">{busy ? 'Ищем…' : 'Найти анкеты'}</button>
          <button type="button" onClick={() => setSwipeMode(value => !value)} className="mb-3 w-full rounded-xl border border-emerald-500/30 px-4 py-2.5 text-xs font-semibold text-emerald-200">{swipeMode ? 'Переключиться на список анкет' : 'Режим свайпов — по одной анкете'}</button>
          {swipeMode && <p className="mb-3 text-[11px] text-stone-400">На телефоне проведите вправо, чтобы пропустить, или влево, чтобы отправить симпатию. Можно также использовать кнопки.</p>}
          {notice && <p role="status" className="mb-3 text-xs text-stone-300">{notice}</p>}
          <div className={swipeMode ? 'mx-auto max-w-lg space-y-3' : 'space-y-3'}>
            {profiles.slice(0, swipeMode ? 1 : profiles.length).map(profile => (
              <article key={profile.id}
                onTouchStart={event => {
                  if (swipeMode && !(event.target as HTMLElement).closest('button, input, select, textarea')) touchStartX.current = event.changedTouches[0]?.clientX ?? null;
                }}
                onTouchEnd={event => {
                  if (!swipeMode || (event.target as HTMLElement).closest('button, input, select, textarea')) { touchStartX.current = null; return; }
                  const start = touchStartX.current;
                  touchStartX.current = null;
                  if (start === null) return;
                  const endX = event.changedTouches[0]?.clientX;
                  if (endX === undefined) return;
                  const delta = endX - start;
                  if (delta < -80) void like(profile);
                  else if (delta > 80) void pass(profile);
                }}
                className={`rounded-2xl border border-white/10 bg-stone-950/70 p-3 ${swipeMode ? 'touch-pan-y' : ''}`}>
                {profile.photoUrls?.length ? (
                  <div className="mb-3 flex gap-2 overflow-x-auto">
                    {profile.photoUrls.slice(0, 6).map((url, index) => (
                      <img key={url} src={url} alt={`Фото профиля ${profile.displayName}, ${index + 1}`} loading="lazy" referrerPolicy="no-referrer" className="h-28 w-24 shrink-0 rounded-xl border border-white/10 bg-stone-900 object-cover" />
                    ))}
                  </div>
                ) : (
                  <div className="mb-3 flex h-20 items-center justify-center rounded-xl border border-dashed border-white/10 text-xs text-stone-500">Фотографии не добавлены</div>
                )}
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h4 className="font-semibold text-white">{profile.displayName}, {profile.age}</h4>
                    <p className="mt-1 text-xs text-stone-400">{profile.city}, {profile.country}</p>
                  </div>
                  {profile.financialAlignment !== null && <span className="shrink-0 rounded-full border border-emerald-500/30 px-2 py-1 text-[10px] text-emerald-300">Финансы {profile.financialAlignment}%</span>}
                </div>
                {profile.bio && <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-stone-300">{profile.bio}</p>}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {profile.relationshipIntent === 'family_without_marriage' && <span className="rounded-full border border-amber-500/20 bg-amber-950/30 px-2 py-1 text-[10px] text-amber-200">Семья без брака</span>}
                  {profile.familyFormat === 'cohabitation' && <span className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-stone-300">Совместная жизнь без регистрации</span>}
                  {profile.hasChildren === true && <span className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-stone-300">Есть дети</span>}
                  {profile.hasChildren === false && <span className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-stone-400">Детей нет</span>}
                  {profile.wantsChildren === 'yes' && <span className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-stone-300">Хочет детей</span>}
                  {profile.wantsChildren === 'no' && <span className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-stone-300">Не планирует детей</span>}
                </div>
                {(profile.occupation || profile.education) && <p className="mt-2 text-xs text-stone-400">{[profile.occupation, profile.education].filter(Boolean).join(' · ')}</p>}
                {profile.languages?.length ? <p className="mt-1 text-xs text-stone-400">Языки: {profile.languages.join(', ')}</p> : null}
                <p className="mt-2 text-[10px] text-stone-500">{profile.relationshipIntent === 'marriage_family' ? 'Цель: брак и семья' : 'Цель: серьёзные отношения'}</p>
                <button type="button" onClick={() => void like(profile)} disabled={likedIds.includes(profile.id)} className="mt-3 w-full rounded-xl border border-rose-500/30 px-3 py-2.5 text-xs font-bold text-rose-200 disabled:opacity-50">{likedIds.includes(profile.id) ? 'Симпатия отправлена' : 'Отправить симпатию'}</button>
                <button type="button" onClick={() => void pass(profile)} disabled={busy} className="mt-2 w-full rounded-xl border border-white/10 px-3 py-2.5 text-xs font-semibold text-stone-300 disabled:opacity-50">Пропустить анкету</button>
                <button type="button" onClick={() => void block(profile)} disabled={busy || blockedIds.includes(profile.id)} className="mt-2 w-full rounded-xl border border-white/10 px-3 py-2 text-xs text-stone-400 disabled:opacity-50">Скрыть и заблокировать</button>
                <button type="button" onClick={() => { setReportTargetId(reportTargetId === profile.id ? null : profile.id); setReportDetails(''); }} className="mt-2 w-full rounded-xl border border-white/10 px-3 py-2 text-xs text-stone-400">Пожаловаться</button>
                {reportTargetId === profile.id && (
                  <div className="mt-2 space-y-2 rounded-xl border border-white/10 bg-stone-900 p-3">
                    <label className="block text-xs text-stone-300">Причина<select value={reportCategory} onChange={e => setReportCategory(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-stone-950 p-2 text-xs text-white"><option value="fake_profile">Подозрение на фейковую анкету</option><option value="spam">Спам или мошенничество</option><option value="harassment">Оскорбления или преследование</option><option value="safety">Угроза безопасности</option><option value="children_misrepresentation">Сокрытие наличия детей</option><option value="duplicate_profile">Повторная анкета</option><option value="other">Другое</option></select></label>
                    <label className="block text-xs text-stone-300">Комментарий (необязательно)<textarea value={reportDetails} onChange={e => setReportDetails(e.target.value)} maxLength={2000} rows={2} className="mt-1 w-full rounded-lg border border-white/10 bg-stone-950 p-2 text-xs text-white" /></label>
                    <button type="button" onClick={() => void submitReport(profile)} disabled={busy} className="w-full rounded-lg bg-rose-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{busy ? 'Отправляем…' : 'Отправить жалобу'}</button>
                  </div>
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
};
