import React, { useCallback, useEffect, useState } from 'react';

type Photo = { status: 'pending' | 'approved' | 'rejected'; createdAt: string };
type IdentityStatus = 'not_configured' | 'not_started' | 'pending' | 'verified' | 'rejected';
type Summary = {
  email: { status: 'verified' | 'unverified'; verifiedAt: string | null };
  phone: { status: 'verified' | 'not_verified'; verifiedAt: string | null };
  identity: { status: IdentityStatus; providerStatus?: string | null; environment?: 'sandbox' | null };
  photos: Photo[];
};

function validSummary(value: unknown): value is Summary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const isRecord = (item: unknown): item is Record<string, unknown> =>
    !!item && typeof item === 'object' && !Array.isArray(item);
  const date = (item: unknown) => item === null ||
    (typeof item === 'string' && Number.isFinite(Date.parse(item)));
  if (!isRecord(v.email) || !isRecord(v.phone) || !isRecord(v.identity) || !Array.isArray(v.photos)) return false;
  return ['verified', 'unverified'].includes(String(v.email.status)) && date(v.email.verifiedAt)
    && ['verified', 'not_verified'].includes(String(v.phone.status)) && date(v.phone.verifiedAt)
    && ['not_configured', 'not_started', 'pending', 'verified', 'rejected'].includes(String(v.identity.status))
    && (v.identity.providerStatus === undefined || v.identity.providerStatus === null || ['Not Started', 'In Progress', 'Approved', 'Declined', 'In Review', 'Awaiting User', 'Resubmitted', 'Expired', 'Abandoned', 'Kyc Expired'].includes(String(v.identity.providerStatus)))
    && (v.identity.environment === undefined || v.identity.environment === null || v.identity.environment === 'sandbox')
    && v.photos.length <= 6
    && v.photos.every((photo: unknown) => isRecord(photo)
      && ['pending', 'approved', 'rejected'].includes(String(photo.status))
      && typeof photo.createdAt === 'string' && date(photo.createdAt));
}


const formatDate = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

export const TrustCenterPanel: React.FC = () => {
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [startingVerification, setStartingVerification] = useState(false);

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

  const startVerification = useCallback(async () => {
    setStartingVerification(true);
    setError('');
    try {
      const response = await fetch('/api/identity/didit/session', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || typeof payload?.verificationUrl !== 'string' ||
          typeof payload?.sessionId !== 'string' || payload.environment !== 'sandbox') {
        if (response.status === 409) throw new Error('Личность уже подтверждена.');
        if (response.status === 503) throw new Error('Проверка личности пока не настроена или временно недоступна.');
        throw new Error('Не удалось начать проверку личности. Попробуйте ещё раз.');
      }
      const verificationUrl = new URL(payload.verificationUrl);
      if (verificationUrl.protocol !== 'https:' || verificationUrl.hostname !== 'verify.didit.me') {
        throw new Error('Получена недействительная ссылка проверки.');
      }
      window.location.assign(verificationUrl.toString());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось начать проверку.');
    } finally { setStartingVerification(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);


  const status = (ok: boolean, yes: string, no: string) => <span className={`text-xs font-semibold ${ok ? 'text-emerald-300' : 'text-amber-300'}`}>{ok ? yes : no}</span>;
  const identityLabels: Record<IdentityStatus, string> = {
    not_configured: 'Не подключено',
    not_started: 'Не пройдена',
    pending: 'На проверке',
    verified: 'Личность подтверждена',
    rejected: 'Требуется повторная проверка'
  };
  const identityVerified = data?.identity.status === 'verified' && data.identity.environment !== 'sandbox';
  const canStartIdentity = data?.identity.status === 'not_started' || data?.identity.status === 'pending' || data?.identity.status === 'rejected';

  return <section className="w-full max-w-xl mx-auto p-3 text-left" aria-labelledby="trust-center-title">
    <div className="rounded-3xl bg-stone-900 border border-white/10 p-5 shadow-xl">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div><h2 id="trust-center-title" className="text-lg font-heading font-black text-white">Центр безопасности</h2><p className="text-xs text-stone-400 mt-1">Статусы безопасности аккаунта</p></div>
        <button type="button" onClick={() => void load()} disabled={loading} className="min-h-11 px-3 rounded-xl bg-stone-800 text-xs text-white disabled:opacity-50">{loading ? 'Загрузка…' : 'Обновить'}</button>
      </div>
      {loading && <p role="status" className="text-sm text-stone-300">Загружаем статусы…</p>}
      {error && <p role="alert" className="rounded-xl border border-rose-500/30 bg-rose-950/30 p-3 text-sm text-rose-200">{error}</p>}
      {data && !loading && <div className="space-y-3">
        <div className="rounded-2xl bg-stone-950 p-3"><div className="flex justify-between"><span className="text-sm text-white">Email</span>{status(data.email.status === 'verified', 'Подтверждён', 'Не подтверждён')}</div>{data.email.verifiedAt && <p className="text-[11px] text-stone-500 mt-1">Подтверждён: {formatDate(data.email.verifiedAt)}</p>}</div>
        <div className="rounded-2xl bg-stone-950 p-3"><div className="flex justify-between"><span className="text-sm text-white">Телефон</span>{status(data.phone.status === 'verified', 'Подтверждён', 'Нет подтверждения')}</div>{data.phone.verifiedAt ? <p className="text-[11px] text-stone-500 mt-1">Подтверждён: {formatDate(data.phone.verifiedAt)}</p> : <p className="text-[11px] text-stone-500 mt-1">SMS-проверка пока не подключена.</p>}</div>
        <div className="rounded-2xl bg-stone-950 p-3">
          <div className="flex justify-between gap-3"><span className="text-sm text-white">Документы и liveness</span>{status(identityVerified, data.identity.environment === 'sandbox' ? 'Sandbox · тест' : identityLabels[data.identity.status], identityLabels[data.identity.status])}</div>
          <p className="text-[11px] text-stone-500 mt-1">{identityVerified
            ? 'Проверка личности подтверждена.'
            : data.identity.status === 'pending'
              ? 'Тестовая сессия Didit. Даже результат Approved в Sandbox не подтверждает личность и не выдаёт значок.'
              : data.identity.status === 'rejected'
                ? 'Провайдер не подтвердил проверку. Можно пройти её повторно.'
                : data.identity.status === 'not_started'
                  ? 'Проверка личности доступна через защищённую страницу Didit (Sandbox).'
                  : 'Проверка через внешнего провайдера не настроена. Значок верификации не присваивается.'}</p>
          {canStartIdentity && <button type="button" onClick={() => void startVerification()} disabled={startingVerification} className="mt-3 min-h-11 w-full rounded-xl bg-rose-700 px-4 text-sm font-semibold text-white disabled:opacity-50">{startingVerification ? 'Подготавливаем проверку…' : data.identity.status === 'pending' ? 'Продолжить проверку' : data.identity.status === 'rejected' ? 'Повторить проверку' : 'Начать проверку'}</button>}
          {data.identity.status !== 'not_configured' && <p className="mt-2 rounded-lg border border-amber-500/30 bg-amber-950/20 p-2 text-[11px] text-amber-200">Sandbox имитирует проверку. Не загружайте реальные документы, селфи или личные данные: Didit сохраняет захваченные материалы и в Sandbox. Тестовый результат не подтверждает личность.</p>}
          {data.identity.environment === 'sandbox' && data.identity.providerStatus && <p className="mt-2 text-[11px] text-amber-300">Тестовый ответ Didit: {data.identity.providerStatus}. Он не является подтверждением личности.</p>}
        </div>
        <div className="rounded-2xl bg-stone-950 p-3"><div className="flex justify-between"><span className="text-sm text-white">Фотографии</span><span className="text-xs text-stone-300">{data.photos.length} / 6</span></div>
          {data.photos.length ? <ul className="mt-2 space-y-2">{data.photos.map((p, i) => <li key={p.createdAt + i} className="flex justify-between gap-3 text-xs"><span className="text-stone-400">Фото {i + 1} · {formatDate(p.createdAt)}</span>{status(p.status === 'approved', p.status === 'approved' ? 'Одобрено' : '', p.status === 'pending' ? 'Ожидает проверки' : 'Отклонено')}</li>)}</ul> : <p className="text-[11px] text-stone-500 mt-1">Загруженных фотографий нет.</p>}
          <p className="text-[11px] text-stone-500 mt-2">Одобрение фотографии не подтверждает личность владельца.</p>
        </div>
      </div>}
    </div>
  </section>;
};
