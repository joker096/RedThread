import React, { useCallback, useEffect, useState } from 'react';
import { useLocale } from '../i18n/LocaleProvider.tsx';

type DatePlan = {
  id: string; proposedBy: string; venueName: string; startsAt: string; timeZone: string;
  status: 'proposed' | 'confirmed'; confirmedByAAt: string | null; confirmedByBAt: string | null;
};
type Props = { matchId: string; currentUserId: string | null };
const localDateTime = (date: Date) => {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export const DatePlanPanel: React.FC<Props> = ({ matchId, currentUserId }) => {
  const { t, formatDate } = useLocale();
  const [plan, setPlan] = useState<DatePlan | null>(null);
  const [userAId, setUserAId] = useState('');
  const [userBId, setUserBId] = useState('');
  const [venueName, setVenueName] = useState('');
  const [startsAt, setStartsAt] = useState(() => localDateTime(new Date(Date.now() + 24 * 60 * 60 * 1000)));
  const [isPublicVenue, setIsPublicVenue] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/matches/${encodeURIComponent(matchId)}/date-plan`, { credentials: 'include' });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(t('datePlanLoadError'));
      const next = data?.datePlan;
      setPlan(next && typeof next.id === 'string' ? next : null);
      setUserAId(typeof data?.userAId === 'string' ? data.userAId : '');
      setUserBId(typeof data?.userBId === 'string' ? data.userBId : '');
      if (next) {
        setVenueName(next.venueName || '');
        setStartsAt(localDateTime(new Date(next.startsAt)));
        setIsPublicVenue(true);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('datePlanLoadError'));
    } finally { setLoading(false); }
  }, [matchId, t]);
  useEffect(() => { void refresh(); }, [refresh]);

  const submit = async (path: string, body?: unknown) => {
    if (saving) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const response = await fetch(`/api/matches/${encodeURIComponent(matchId)}/date-plan${path}`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(response.status === 404 ? t('datePlanUnavailable') : t('datePlanActionError'));
      if (data?.datePlan) setPlan(data.datePlan);
      if (data?.declined) { setPlan(null); setNotice(t('datePlanDeclined')); }
      else if (data?.cancelled) { setPlan(null); setNotice(t('datePlanCancelled')); }
      else if (data?.datePlan?.status === 'confirmed') setNotice(t('datePlanConfirmed'));
      else setNotice(t('datePlanSaved'));
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('datePlanActionError'));
      await refresh();
    } finally { setSaving(false); }
  };

  const myConfirmed = plan && (currentUserId === userAId ? plan.confirmedByAAt : currentUserId === userBId ? plan.confirmedByBAt : null);
  const otherConfirmed = plan && (currentUserId === userAId ? plan.confirmedByBAt : currentUserId === userBId ? plan.confirmedByAAt : null);
  const minDate = localDateTime(new Date(Date.now() + 30 * 60 * 1000));
  return (
    <section data-testid="date-plan-panel" className="mb-4 rounded-xl border border-rose-400/20 bg-rose-950/15 p-3">
      <h4 className="text-sm font-bold text-white">{t('datePlanTitle')}</h4>
      <p className="mt-1 text-xs leading-relaxed text-stone-400">{t('datePlanIntro')}</p>
      {loading ? <p role="status" className="mt-3 text-xs text-stone-400">{t('loading')}</p> : (
        <>
          {plan && (
            <div className="mt-3 rounded-lg border border-white/10 bg-stone-900/70 p-3">
              <p className="text-sm font-semibold text-white">{plan.venueName}</p>
              <p data-testid="date-plan-time" className="mt-1 break-words text-xs text-stone-300">{formatDate(plan.startsAt, { dateStyle: 'medium', timeStyle: 'short', timeZone: plan.timeZone })} · {plan.timeZone}</p>
              {plan.status === 'confirmed' ? (
                <div>
                  <p role="status" className="mt-2 text-xs font-semibold text-emerald-300">{t('datePlanConfirmed')}</p>
                  <button type="button" disabled={saving} onClick={() => { if (window.confirm(t('datePlanCancelConfirm'))) void submit('/cancel'); }} className="mt-2 min-h-11 w-full rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold text-stone-200 disabled:opacity-50">{t('datePlanCancel')}</button>
                </div>
              ) : (
                <div className="mt-2 space-y-2">
                  <p className="text-xs text-amber-200">{otherConfirmed ? t('datePlanOneConfirmed') : t('datePlanWaitingBoth')}</p>
                  {!myConfirmed && <button type="button" disabled={saving} onClick={() => void submit('/confirm')} className="min-h-11 w-full rounded-lg bg-rose-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{t('datePlanConfirm')}</button>}
                  <button type="button" disabled={saving} onClick={() => void submit('/decline')} className="min-h-11 w-full rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold text-stone-200 disabled:opacity-50">{t('datePlanDecline')}</button>
                </div>
              )}
            </div>
          )}
          <form className="mt-3 space-y-2" onSubmit={event => {
            event.preventDefault();
            void submit('', {
              venueName, startsAt: new Date(startsAt).toISOString(),
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              isPublicVenue
            });
          }}>
            <label className="block text-xs text-stone-300">{t('datePlanVenue')}
              <input value={venueName} onChange={event => setVenueName(event.target.value)} minLength={2} maxLength={120} required placeholder={t('datePlanVenuePlaceholder')} className="mt-1 min-h-11 w-full rounded-lg border border-white/10 bg-stone-900 px-3 py-2 text-sm text-white" />
            </label>
            <label className="block text-xs text-stone-300">{t('datePlanDateTime')}
              <input type="datetime-local" value={startsAt} min={minDate} onChange={event => setStartsAt(event.target.value)} required className="mt-1 min-h-11 w-full rounded-lg border border-white/10 bg-stone-900 px-3 py-2 text-sm text-white" />
            </label>
            <label className="flex min-h-11 items-center gap-2 text-xs text-stone-300">
              <input type="checkbox" checked={isPublicVenue} onChange={event => setIsPublicVenue(event.target.checked)} required className="h-4 w-4 accent-rose-500" />
              {t('datePlanPublicVenue')}
            </label>
            <p className="text-[11px] leading-relaxed text-stone-500">{t('datePlanPrivacy')}</p>
            <button type="submit" disabled={saving || !venueName.trim() || !isPublicVenue || !startsAt} className="min-h-11 w-full rounded-lg border border-rose-400/30 bg-rose-600/15 px-3 py-2 text-xs font-bold text-rose-100 disabled:opacity-40">{saving ? t('giftOrdersWorking') : plan ? t('datePlanUpdate') : t('datePlanPropose')}</button>
          </form>
        </>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-rose-300">{error}</p>}
      {notice && <p role="status" className="mt-2 text-xs text-emerald-300">{notice}</p>}
      {!loading && <button data-testid="date-plan-refresh" type="button" onClick={() => void refresh()} disabled={saving} className="mt-2 min-h-10 w-full text-xs text-stone-400 underline disabled:opacity-50">{t('refreshMessages')}</button>}
    </section>
  );
};
