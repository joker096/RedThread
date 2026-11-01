import React, { useCallback, useEffect, useState } from 'react';

type Photo = { status: 'pending' | 'approved' | 'rejected'; createdAt: string };
type Summary = {
  email: { status: 'verified' | 'unverified'; verifiedAt: string | null };
  phone: { status: 'verified' | 'not_verified'; verifiedAt: string | null };
  identity: { status: 'not_configured' };
  photos: Photo[];
};

function validSummary(value: unknown): value is Summary {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, any>;
  const date = (x: unknown) => x === null || (typeof x === 'string' && Number.isFinite(Date.parse(x)));
  return !!v.email && ['verified', 'unverified'].includes(v.email.status) && date(v.email.verifiedAt)
    && !!v.phone && ['verified', 'not_verified'].includes(v.phone.status) && date(v.phone.verifiedAt)
    && v.identity?.status === 'not_configured' && Array.isArray(v.photos) && v.photos.length <= 6
    && v.photos.every((p: any) => p && ['pending', 'approved', 'rejected'].includes(p.status) && typeof p.createdAt === 'string' && date(p.createdAt));
}

const formatDate = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

export const TrustCenterPanel: React.FC = () => {
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/trust/summary', { credentials: 'include', cache: 'no-store' });
      if (response.status === 401) throw new Error('Войдите в аккаунт, чтобы просмотреть статусы безопасности.');
      if (!response.ok) throw new Error('Не удалось загрузить данные Центра безопасности.');
      const payload: unknown = await response.json();
      if (!validSummary(payload)) throw new Error('Сервер вернул некорректные данные безопасности.');
      setData(payload);
    } catch (e) {
      setData(null); setError(e instanceof Error ? e.message : 'Ошибка загрузки.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const status = (ok: boolean, yes: string, no: string) => <span className={`text-xs font-semibold ${ok ? 'text-emerald-300' : 'text-amber-300'}`}>{ok ? yes : no}</span>;

  return <section className="w-full max-w-xl mx-auto p-3 text-left" aria-labelledby="trust-center-title">
    <div className="rounded-3xl bg-stone-900 border border-white/10 p-5 shadow-xl">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div><h2 id="trust-center-title" className="text-lg font-heading font-black text-white">Центр безопасности</h2><p className="text-xs text-stone-400 mt-1">Реальные статусы вашего аккаунта</p></div>
        <button type="button" onClick={() => void load()} disabled={loading} className="min-h-11 px-3 rounded-xl bg-stone-800 text-xs text-white disabled:opacity-50">{loading ? 'Загрузка…' : 'Обновить'}</button>
      </div>
      {loading && <p role="status" className="text-sm text-stone-300">Загружаем статусы…</p>}
      {error && <p role="alert" className="rounded-xl border border-rose-500/30 bg-rose-950/30 p-3 text-sm text-rose-200">{error}</p>}
      {data && !loading && <div className="space-y-3">
        <div className="rounded-2xl bg-stone-950 p-3"><div className="flex justify-between"><span className="text-sm text-white">Email</span>{status(data.email.status === 'verified', 'Подтверждён', 'Не подтверждён')}</div>{data.email.verifiedAt && <p className="text-[11px] text-stone-500 mt-1">Подтверждён: {formatDate(data.email.verifiedAt)}</p>}</div>
        <div className="rounded-2xl bg-stone-950 p-3"><div className="flex justify-between"><span className="text-sm text-white">Телефон</span>{status(data.phone.status === 'verified', 'Подтверждён', 'Нет подтверждения')}</div>{data.phone.verifiedAt ? <p className="text-[11px] text-stone-500 mt-1">Подтверждён: {formatDate(data.phone.verifiedAt)}</p> : <p className="text-[11px] text-stone-500 mt-1">SMS-проверка пока не подключена.</p>}</div>
        <div className="rounded-2xl bg-stone-950 p-3"><div className="flex justify-between"><span className="text-sm text-white">Документы и liveness</span>{status(false, '', 'Не подключено')}</div><p className="text-[11px] text-stone-500 mt-1">Проверка через внешнего провайдера ещё не настроена. Значок верификации не присваивается.</p></div>
        <div className="rounded-2xl bg-stone-950 p-3"><div className="flex justify-between"><span className="text-sm text-white">Фотографии</span><span className="text-xs text-stone-300">{data.photos.length} / 6</span></div>
          {data.photos.length ? <ul className="mt-2 space-y-2">{data.photos.map((p, i) => <li key={p.createdAt + i} className="flex justify-between gap-3 text-xs"><span className="text-stone-400">Фото {i + 1} · {formatDate(p.createdAt)}</span>{status(p.status === 'approved', p.status === 'approved' ? 'Одобрено' : '', p.status === 'pending' ? 'Ожидает проверки' : 'Отклонено')}</li>)}</ul> : <p className="text-[11px] text-stone-500 mt-1">Загруженных фотографий нет.</p>}
          <p className="text-[11px] text-stone-500 mt-2">Одобрение фотографии не подтверждает личность владельца.</p>
        </div>
      </div>}
    </div>
  </section>;
};
