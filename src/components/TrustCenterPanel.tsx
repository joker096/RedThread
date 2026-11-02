import React, { useCallback, useEffect, useState } from 'react';

type Photo = { status: 'pending' | 'approved' | 'rejected'; createdAt: string };
type IdentityStatus = 'not_configured' | 'not_started' | 'pending' | 'verified' | 'rejected';
type L3Consent = {
  version: number;
  notice: { version: number; title: string; text: string };
  accepted: boolean;
  enabled: boolean;
  grantedAt: string | null;
  withdrawnAt: string | null;
  purgeStatus: 'complete' | 'pending' | 'failed';
  pendingPurgeJobs: number;
  failedPurgeJobs: number;
};
type Summary = {
  email: { status: 'verified' | 'unverified'; verifiedAt: string | null };
  phone: { status: 'verified' | 'not_verified'; verifiedAt: string | null };
  identity: { gender: 'male' | 'female'; status: IdentityStatus; providerStatus?: string | null; environment?: 'sandbox' | 'live' | null; l3: { status: string; decisionStatus: string; expiresAt?: string } };
  photos: Photo[];
};

export function shouldOfferL3PurgeRetry(consent: L3Consent | null): boolean {
  return Boolean(consent && !consent.accepted &&
    consent.purgeStatus === 'failed' && consent.failedPurgeJobs > 0);
}

export function validL3Consent(value: unknown): value is L3Consent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const notice = v.notice as Record<string, unknown> | null;
  return Number.isInteger(v.version) && v.version === 1
    && !!notice && typeof notice === 'object'
    && notice.version === v.version
    && typeof notice.title === 'string' && notice.title.length > 0
    && typeof notice.text === 'string' && notice.text.length > 0
    && typeof v.accepted === 'boolean'
    && typeof v.enabled === 'boolean'
    && (v.grantedAt === null || (typeof v.grantedAt === 'string' && Number.isFinite(Date.parse(v.grantedAt))))
    && (v.withdrawnAt === null || (typeof v.withdrawnAt === 'string' && Number.isFinite(Date.parse(v.withdrawnAt))))
    && ['complete', 'pending', 'failed'].includes(String(v.purgeStatus))
    && Number.isInteger(v.pendingPurgeJobs) && Number(v.pendingPurgeJobs) >= 0
    && Number.isInteger(v.failedPurgeJobs) && Number(v.failedPurgeJobs) >= 0;
}

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
    && ['male', 'female'].includes(String(v.identity.gender))
    && ['not_configured', 'not_started', 'pending', 'verified', 'rejected'].includes(String(v.identity.status))
    && isRecord(v.identity.l3)
    && typeof v.identity.l3.status === 'string'
    && typeof v.identity.l3.decisionStatus === 'string'
    && (v.identity.providerStatus === undefined || v.identity.providerStatus === null || ['Not Started', 'In Progress', 'Approved', 'Declined', 'In Review', 'Awaiting User', 'Resubmitted', 'Expired', 'Abandoned', 'Kyc Expired'].includes(String(v.identity.providerStatus)))
    && (v.identity.environment === undefined || v.identity.environment === null || ['sandbox', 'live'].includes(String(v.identity.environment)))
    && v.photos.length <= 6
    && v.photos.every((photo: unknown) => isRecord(photo)
      && ['pending', 'approved', 'rejected'].includes(String(photo.status))
      && typeof photo.createdAt === 'string' && date(photo.createdAt));
}


const formatDate = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

export const TrustCenterPanel: React.FC = () => {
  const [data, setData] = useState<Summary | null>(null);
  const [l3Consent, setL3Consent] = useState<L3Consent | null>(null);
  const [l3ConsentAcknowledged, setL3ConsentAcknowledged] = useState(false);
  const [savingL3Consent, setSavingL3Consent] = useState(false);
  const [selectedL3Video, setSelectedL3Video] = useState<File | null>(null);
  const [uploadingL3Video, setUploadingL3Video] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [startingVerification, setStartingVerification] = useState(false);
  const [identityConsent, setIdentityConsent] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [response, consentResponse] = await Promise.all([
        fetch('/api/trust/summary', { credentials: 'include', cache: 'no-store' }),
        fetch('/api/identity/l3/consent', { credentials: 'include', cache: 'no-store' })
      ]);
      if (response.status === 401) throw new Error('Войдите в аккаунт, чтобы просмотреть статусы безопасности.');
      if (!response.ok) throw new Error('Не удалось загрузить данные Центра безопасности.');
      const payload: unknown = await response.json();
      if (!validSummary(payload)) throw new Error('Сервер вернул некорректные данные безопасности.');
      if (!consentResponse.ok) throw new Error('Не удалось загрузить согласие на видео-проверку L3.');
      const consentPayload: unknown = await consentResponse.json();
      if (!validL3Consent(consentPayload)) throw new Error('Сервер вернул некорректное состояние согласия L3.');
      setData(payload);
      setL3Consent(consentPayload);
      setL3ConsentAcknowledged(false);
    } catch (e) {
      setData(null); setL3Consent(null); setError(e instanceof Error ? e.message : 'Ошибка загрузки.');
    } finally { setLoading(false); }
  }, []);

  const startVerification = useCallback(async () => {
    setStartingVerification(true);
    setError('');
    try {
      const response = await fetch('/api/identity/didit/session', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consentVersion: 'didit-kyc-v1' })
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || typeof payload?.verificationUrl !== 'string' ||
          typeof payload?.sessionId !== 'string' || !['sandbox', 'live'].includes(payload.environment)) {
        if (response.status === 409) throw new Error(payload?.error === 'identity_verification_in_progress'
          ? 'Проверка уже запущена. Не создаём дубликат сессии — дождитесь решения Didit.'
          : 'Личность уже подтверждена.');
        if (response.status === 429) throw new Error('Бесплатный месячный лимит проверок исчерпан. Новая сессия не создана.');
        if (response.status === 503) throw new Error('Проверка личности пока не настроена или временно недоступна.');
        throw new Error('Не удалось начать проверку личности. Попробуйте ещё раз.');
      }
      const verificationUrl = new URL(payload.verificationUrl);
      if (verificationUrl.protocol !== 'https:' || verificationUrl.hostname !== 'verify.didit.me') {
        throw new Error('Получена недействительная ссылка проверки.');
      }
      setIdentityConsent(false);
      window.location.assign(verificationUrl.toString());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось начать проверку.');
    } finally { setStartingVerification(false); }
  }, []);

  const grantL3Consent = useCallback(async () => {
    if (!l3ConsentAcknowledged || !l3Consent || !data || data.identity.gender !== 'male' ||
        data.identity.status !== 'verified' || data.identity.environment !== 'live') return;
    setSavingL3Consent(true);
    setError('');
    try {
      const response = await fetch('/api/identity/l3/consent', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accepted: true, version: l3Consent.version })
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(response.status === 409
        ? 'Для согласия L3 требуется действующая проверка L2 в Live.'
        : 'Не удалось сохранить согласие L3.');
      if (payload?.accepted !== true || payload?.version !== l3Consent.version) {
        throw new Error('Сервер не подтвердил сохранение согласия L3.');
      }
      setL3ConsentAcknowledged(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сохранить согласие L3.');
    } finally {
      setSavingL3Consent(false);
    }
  }, [data, l3Consent, l3ConsentAcknowledged, load]);

  const withdrawL3Consent = useCallback(async () => {
    const retryingPurge = Boolean(l3Consent && !l3Consent.accepted &&
      l3Consent.purgeStatus === 'failed' && l3Consent.failedPurgeJobs > 0);
    const confirmation = retryingPurge
      ? 'Повторить удаление видео L3? Доступ к подтверждённому статусу уже закрыт.'
      : 'Отозвать согласие L3? Доступ к подтверждённому статусу будет немедленно закрыт, а видео поставлено в очередь на удаление.';
    if (!window.confirm(confirmation)) return;
    setSavingL3Consent(true);
    setError('');
    try {
      const response = await fetch('/api/identity/l3/consent', {
        method: 'DELETE', credentials: 'include'
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error('Не удалось отозвать согласие L3. Попробуйте ещё раз.');
      if (payload?.accepted !== false) throw new Error('Сервер не подтвердил отзыв согласия L3.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось отозвать согласие L3.');
    } finally {
      setSavingL3Consent(false);
    }
  }, [l3Consent, load]);

  const uploadL3Video = useCallback(async () => {
    if (!selectedL3Video || !l3Consent?.accepted || !data ||
        data.identity.gender !== 'male' || data.identity.status !== 'verified' ||
        data.identity.environment !== 'live') return;
    if (!['video/mp4', 'video/webm'].includes(selectedL3Video.type)) {
      setError('Выберите видео в формате MP4 или WebM.');
      return;
    }
    if (selectedL3Video.size < 1 || selectedL3Video.size > 100 * 1024 * 1024) {
      setError('Размер видео должен быть не больше 100 МБ.');
      return;
    }
    setUploadingL3Video(true);
    setError('');
    let objectUrl: string | null = null;
    try {
      objectUrl = URL.createObjectURL(selectedL3Video);
      const duration = await new Promise<number>((resolve, reject) => {
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.onloadedmetadata = () => resolve(video.duration);
        video.onerror = () => reject(new Error('Не удалось прочитать длительность видео.'));
        video.src = objectUrl as string;
      });
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
      if (!Number.isFinite(duration) || duration < 30 || duration > 60) {
        throw new Error('Длительность видео должна быть от 30 до 60 секунд.');
      }

      const capabilityResponse = await fetch('/api/identity/l3/upload-capability', {
        method: 'POST', credentials: 'include'
      });
      const capability = await capabilityResponse.json().catch(() => null);
      if (!capabilityResponse.ok || typeof capability?.uploadToken !== 'string') {
        throw new Error(capability?.error === 'l3_consent_required'
          ? 'Согласие L3 больше не действует. Обновите Центр безопасности.'
          : 'Не удалось подготовить защищённую загрузку видео.');
      }
      const uploadResponse = await fetch('/api/identity/l3/upload', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': selectedL3Video.type,
          'X-Identity-L3-Upload-Token': capability.uploadToken
        },
        body: selectedL3Video
      });
      const uploaded = await uploadResponse.json().catch(() => null);
      if (!uploadResponse.ok || uploaded?.status !== 'uploaded') {
        throw new Error(uploaded?.error === 'l3_media_too_large'
          ? 'Видео превышает ограничение 100 МБ.'
          : 'Защищённая загрузка не завершилась. Попробуйте ещё раз.');
      }
      setSelectedL3Video(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить видео L3.');
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUploadingL3Video(false);
    }
  }, [data, l3Consent, selectedL3Video, load]);

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
  const terminalProviderStatuses = ['Declined', 'Expired', 'Abandoned', 'Kyc Expired'];
  const canStartIdentity = data?.identity.status === 'not_started' || data?.identity.status === 'rejected' ||
    (data?.identity.status === 'pending' && terminalProviderStatuses.includes(data.identity.providerStatus || ''));

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
              ? (data.identity.environment === 'sandbox' ? (data.identity.environment === 'sandbox' ? 'Тестовая сессия Didit. Даже Approved в Sandbox не подтверждает личность.' : 'Ожидается решение Didit. Не запускайте повторную сессию, пока текущая проверка не завершена.') : 'Ожидается решение Didit. Доступ к функциям откроется только после подтверждённой проверки.')
              : data.identity.status === 'rejected'
                ? 'Провайдер не подтвердил проверку. Можно пройти её повторно.'
                : data.identity.status === 'not_started'
                  ? 'Проверка личности доступна через защищённую страницу Didit.'
                  : 'Проверка через внешнего провайдера не настроена. Значок верификации не присваивается.'}</p>
          {canStartIdentity && <label className="mt-3 flex items-start gap-2 rounded-xl border border-white/10 bg-stone-900 p-3 text-[11px] leading-relaxed text-stone-300">
            <input type="checkbox" checked={identityConsent} onChange={event => setIdentityConsent(event.target.checked)} className="mt-0.5 h-4 w-4 accent-rose-600" />
            <span>Я даю согласие на передачу Didit данных, необходимых для проверки личности: изображения документа, селфи и видео liveness, а также биометрическое сравнение лица. Didit обрабатывает и хранит эти материалы по своим правилам. Vow сохраняет только идентификаторы сессии, технический статус и запись о версии согласия; сами документы и биометрические материалы в Vow не сохраняются.</span>
          </label>}
          {canStartIdentity && <button type="button" onClick={() => void startVerification()} disabled={startingVerification || !identityConsent} className="mt-3 min-h-11 w-full rounded-xl bg-rose-700 px-4 text-sm font-semibold text-white disabled:opacity-50">{startingVerification ? 'Подготавливаем проверку…' : data.identity.status === 'pending' ? 'Повторить проверку' : data.identity.status === 'rejected' ? 'Повторить проверку' : 'Начать проверку'}</button>}
          {data.identity.environment === 'sandbox' && <p className="mt-2 rounded-lg border border-amber-500/30 bg-amber-950/20 p-2 text-[11px] text-amber-200">Sandbox имитирует проверку. Не загружайте реальные документы, селфи или личные данные. Тестовый результат не подтверждает личность.</p>}
          {data.identity.providerStatus && <p className="mt-2 text-[11px] text-stone-400">Ответ Didit ({data.identity.environment}): {data.identity.providerStatus}.</p>}
        </div>
        {data.identity.gender === 'male' && <div className="rounded-2xl bg-stone-950 p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-white">Видео-проверка L3</span>
            {status(data.identity.l3.decisionStatus === 'approved' && l3Consent?.accepted === true,
              'Подтверждена', data.identity.l3.status === 'not_started' ? 'Не начата' : data.identity.l3.status)}
          </div>
          {identityVerified && data.identity.environment === 'live' && l3Consent ? <>
            <p className="mt-2 text-[11px] text-stone-400">
              Статус: {data.identity.l3.status}. Согласие: {l3Consent.accepted ? 'предоставлено' : 'не предоставлено'}.
            </p>
            {l3Consent.accepted ? <>
              <p className="mt-2 text-[11px] text-emerald-200">Действует согласие версии {l3Consent.version}.</p>
              <button type="button" onClick={() => void withdrawL3Consent()} disabled={savingL3Consent}
                className="mt-3 min-h-11 w-full rounded-xl border border-rose-500/40 px-4 text-sm font-semibold text-rose-200 disabled:opacity-50">
                {savingL3Consent ? 'Сохраняем…' : 'Отозвать согласие L3'}
              </button>
            </> : <>
              <label className="mt-3 flex items-start gap-2 rounded-xl border border-white/10 bg-stone-900 p-3 text-[11px] leading-relaxed text-stone-300">
                <input type="checkbox" checked={l3ConsentAcknowledged}
                  onChange={event => setL3ConsentAcknowledged(event.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-rose-600" />
                <span><strong>{l3Consent.notice.title}.</strong> {l3Consent.notice.text}</span>
              </label>
              <button type="button" onClick={() => void grantL3Consent()}
                disabled={savingL3Consent || !l3ConsentAcknowledged}
                className="mt-3 min-h-11 w-full rounded-xl bg-rose-700 px-4 text-sm font-semibold text-white disabled:opacity-50">
                {savingL3Consent ? 'Сохраняем…' : 'Предоставить согласие L3'}
              </button>
              {shouldOfferL3PurgeRetry(l3Consent) && <button type="button"
                onClick={() => void withdrawL3Consent()} disabled={savingL3Consent}
                className="mt-3 min-h-11 w-full rounded-xl border border-rose-500/40 px-4 text-sm font-semibold text-rose-200 disabled:opacity-50">
                {savingL3Consent ? 'Повторяем удаление…' : 'Повторить удаление видео'}
              </button>}
            </>}
            {l3Consent.accepted && l3Consent.enabled && !['uploaded', 'processing', 'pending_review', 'approved'].includes(data.identity.l3.status) && <>
              <label className="mt-3 block rounded-xl border border-white/10 bg-stone-900 p-3 text-[11px] text-stone-300">
                <span className="mb-2 block font-semibold text-white">Видео-заявление · 30–60 секунд · MP4 или WebM · до 100 МБ</span>
                <input type="file" accept="video/mp4,video/webm"
                  onChange={event => setSelectedL3Video(event.target.files?.[0] || null)}
                  disabled={uploadingL3Video}
                  className="block min-h-11 w-full text-xs text-stone-300 file:mr-3 file:min-h-10 file:rounded-lg file:border-0 file:bg-stone-700 file:px-3 file:text-xs file:text-white" />
                {selectedL3Video && <span className="mt-2 block break-all text-stone-400">
                  {selectedL3Video.name} · {(selectedL3Video.size / (1024 * 1024)).toFixed(1)} МБ
                </span>}
              </label>
              <button type="button" onClick={() => void uploadL3Video()}
                disabled={uploadingL3Video || !selectedL3Video}
                className="mt-3 min-h-11 w-full rounded-xl bg-rose-700 px-4 text-sm font-semibold text-white disabled:opacity-50">
                {uploadingL3Video ? 'Загружаем и шифруем…' : 'Отправить видео на проверку L3'}
              </button>
            </>}
            {l3Consent.accepted && l3Consent.enabled && ['uploaded', 'processing', 'pending_review'].includes(data.identity.l3.status) &&
              <p className="mt-3 rounded-lg bg-amber-950/20 p-2 text-[11px] text-amber-200">
                Видео получено. Проверка формата и безопасности выполняется; повторно загружать файл пока не нужно.
              </p>}
            {l3Consent.accepted && l3Consent.enabled && data.identity.l3.status === 'approved' &&
              <p className="mt-3 text-[11px] text-emerald-200">Проверка L3 подтверждена. Повторная загрузка не требуется до окончания срока действия.</p>}
            {!l3Consent.enabled && <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-950/20 p-2 text-[11px] text-amber-200">L3 временно отключена до завершения полного защищённого потока модерации. Согласие можно отозвать в любое время; загрузка видео пока закрыта.</p>}
            {l3Consent.purgeStatus !== 'complete' && <p role="status" className={l3Consent.purgeStatus === 'failed'
              ? 'mt-2 rounded-lg bg-rose-950/30 p-2 text-[11px] text-rose-200'
              : 'mt-2 rounded-lg bg-amber-950/20 p-2 text-[11px] text-amber-200'}>
              {l3Consent.purgeStatus === 'failed'
                ? 'Не удалось удалить ' + l3Consent.failedPurgeJobs + ' видео. Удаление аккаунта остаётся заблокированным до завершения очистки.'
                : 'Видео поставлено в очередь на удаление. Осталось задач: ' + l3Consent.pendingPurgeJobs + '.'}
            </p>}
          </> : <p className="mt-2 text-[11px] text-stone-500">
            Сначала завершите проверку личности L2 в Live. Sandbox не даёт права на L3.
          </p>}
        </div>}
        <div className="rounded-2xl bg-stone-950 p-3"><div className="flex justify-between"><span className="text-sm text-white">Фотографии</span><span className="text-xs text-stone-300">{data.photos.length} / 6</span></div>
          {data.photos.length ? <ul className="mt-2 space-y-2">{data.photos.map((p, i) => <li key={p.createdAt + i} className="flex justify-between gap-3 text-xs"><span className="text-stone-400">Фото {i + 1} · {formatDate(p.createdAt)}</span>{status(p.status === 'approved', p.status === 'approved' ? 'Одобрено' : '', p.status === 'pending' ? 'Ожидает проверки' : 'Отклонено')}</li>)}</ul> : <p className="text-[11px] text-stone-500 mt-1">Загруженных фотографий нет.</p>}
          <p className="text-[11px] text-stone-500 mt-2">Одобрение фотографии не подтверждает личность владельца.</p>
        </div>
      </div>}
    </div>
  </section>;
};
