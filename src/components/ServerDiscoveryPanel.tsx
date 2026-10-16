import React, { useCallback, useEffect, useState } from 'react';

type ServerProfile = {
  id: string;
  displayName: string;
  age: number;
  gender: 'female' | 'male';
  country: string;
  city: string;
  bio: string;
  relationshipIntent: 'marriage_family' | 'serious_relationship';
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
  const [minFinancialAlignment, setMinFinancialAlignment] = useState(0);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [likedIds, setLikedIds] = useState<string[]>([]);

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
    try {
      const response = await fetch(`/api/profiles/search?${params.toString()}`, { credentials: 'include' });
      if (response.status === 401) {
        setAuthenticated(false);
        setProfiles([]);
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
  }, [minAge, maxAge, minFinancialAlignment, country, city, intent]);

  useEffect(() => { void search(); }, [search]);

  const like = async (profile: ServerProfile) => {
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
      if (!response.ok) throw new Error('Не удалось отправить симпатию.');
      setLikedIds(current => current.includes(profile.id) ? current : [...current, profile.id]);
      setNotice(data?.matched ? `У вас взаимная симпатия с ${profile.displayName}! Совпадение создано.` : `Симпатия отправлена анкете «${profile.displayName}».`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Не удалось отправить симпатию.');
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
            <label className="text-xs text-stone-300">Цель отношений<select value={intent} onChange={e => setIntent(e.target.value)} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-2.5 text-sm text-white"><option value="all">Любая</option><option value="marriage_family">Брак и семья</option><option value="serious_relationship">Серьёзные отношения</option></select></label>
            <label className="text-xs text-stone-300">Совпадение финансовых ожиданий<select value={minFinancialAlignment} onChange={e => setMinFinancialAlignment(Number(e.target.value))} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-2.5 text-sm text-white"><option value="0">Не фильтровать</option><option value="33">От 33%</option><option value="67">От 67%</option><option value="100">Только 100%</option></select></label>
          </div>
          <button type="button" onClick={() => void search()} disabled={busy} className="mb-4 w-full rounded-xl bg-emerald-700 px-4 py-3 text-sm font-bold text-white disabled:opacity-50">{busy ? 'Ищем…' : 'Найти анкеты'}</button>
          {notice && <p role="status" className="mb-3 text-xs text-stone-300">{notice}</p>}
          <div className="space-y-3">
            {profiles.map(profile => (
              <article key={profile.id} className="rounded-2xl border border-white/10 bg-stone-950/70 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h4 className="font-semibold text-white">{profile.displayName}, {profile.age}</h4>
                    <p className="mt-1 text-xs text-stone-400">{profile.city}, {profile.country}</p>
                  </div>
                  {profile.financialAlignment !== null && <span className="shrink-0 rounded-full border border-emerald-500/30 px-2 py-1 text-[10px] text-emerald-300">Финансы {profile.financialAlignment}%</span>}
                </div>
                {profile.bio && <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-stone-300">{profile.bio}</p>}
                <p className="mt-2 text-[10px] text-stone-500">{profile.relationshipIntent === 'marriage_family' ? 'Цель: брак и семья' : 'Цель: серьёзные отношения'}</p>
                <button type="button" onClick={() => void like(profile)} disabled={likedIds.includes(profile.id)} className="mt-3 w-full rounded-xl border border-rose-500/30 px-3 py-2.5 text-xs font-bold text-rose-200 disabled:opacity-50">{likedIds.includes(profile.id) ? 'Симпатия отправлена' : 'Отправить симпатию'}</button>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
};
