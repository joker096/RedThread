import React, { useEffect, useRef, useState } from 'react';
import { useLocale } from '../i18n/LocaleProvider.tsx';
import {
  X, Scale, Camera, Shirt, Music2, MapPin,
  FileCheck2, LockKeyhole, HeartHandshake, BadgeCheck,
  ChevronRight, Wallet, AlertTriangle
} from 'lucide-react';

type ServiceCategory = 'all' | 'legal' | 'dress' | 'photo' | 'host' | 'venue' | 'beauty' | 'cafe' | 'transport' | 'other';
type PublishedPartner = { id: string; category: string; businessName: string; country: string; city: string; website: string; serviceDescription: string; priceFrom: string | number | null; priceCurrency: string; serviceLanguages: string[]; availabilityNote: string; publishedAt: string };
type CountryCode = 'GE' | 'RU' | 'KZ' | 'AM';

const categories: Array<{ id: ServiceCategory; ru: string; en: string; icon: React.ElementType }> = [
  { id: 'all', ru: 'Все услуги', en: 'All services', icon: HeartHandshake },
  { id: 'legal', ru: 'Юристы', en: 'Legal', icon: Scale },
  { id: 'dress', ru: 'Платья', en: 'Dresses', icon: Shirt },
  { id: 'photo', ru: 'Фото / видео', en: 'Photo / video', icon: Camera },
  { id: 'host', ru: 'Ведущие', en: 'Hosts', icon: Music2 },
  { id: 'venue', ru: 'Площадки', en: 'Venues', icon: MapPin },
  { id: 'beauty', ru: 'Образ', en: 'Beauty', icon: SparklesIcon },
  { id: 'cafe', ru: 'Кафе', en: 'Cafes', icon: Wallet },
  { id: 'transport', ru: 'Транспорт', en: 'Transport', icon: MapPin },
  { id: 'other', ru: 'Другое', en: 'Other', icon: HeartHandshake }
];

function SparklesIcon(props: React.ComponentProps<'svg'>) {
  return <HeartHandshake {...props} />;
}

interface PartnerServicesMarketplaceProps {
  isOpen: boolean;
  onClose: () => void;
  matchId: string;
  partnerName: string;
}

export const PartnerServicesMarketplace: React.FC<PartnerServicesMarketplaceProps> = ({
  isOpen, onClose, matchId, partnerName
}) => {
  const { locale, formatNumber } = useLocale();
  const tr = (ru: string, en: string) => locale === 'ru' ? ru : en;
  const countryNames: Record<CountryCode, string> = { GE: tr('Грузия', 'Georgia'), RU: tr('Россия', 'Russia'), KZ: tr('Казахстан', 'Kazakhstan'), AM: tr('Армения', 'Armenia') };
  const [category, setCategory] = useState<ServiceCategory>('all');
  const [country, setCountry] = useState<CountryCode>('GE');

  const [publishedPartners, setPublishedPartners] = useState<PublishedPartner[]>([]);
  const [partnersLoading, setPartnersLoading] = useState(false);
  const [partnersError, setPartnersError] = useState('');
  const [inquiryProvider, setInquiryProvider] = useState<PublishedPartner | null>(null);
  const [inquiryNote, setInquiryNote] = useState('');
  const [serviceDate, setServiceDate] = useState('');
  const [shareContact, setShareContact] = useState(false);
  const [inquiryBusy, setInquiryBusy] = useState(false);
  const [inquiryLocked, setInquiryLocked] = useState(false);
  const [inquiryId, setInquiryId] = useState<string | null>(null);
  const [inquiryDeliveryStatus, setInquiryDeliveryStatus] = useState('');
  const [inquiryStatus, setInquiryStatus] = useState('');
  const inquiryRequestKey = useRef<string | null>(null);
  const inquiryMatchId = useRef<string | null>(null);
  useEffect(() => {
    // A submitted request is immutable until the server confirms its outcome.
    // Keep its original match/key/payload if the selected match changes.
    if (inquiryRequestKey.current) return;
    inquiryMatchId.current = null;
    setInquiryProvider(null);
    setInquiryNote('');
    setServiceDate('');
    setShareContact(false);
    setInquiryLocked(false);
    setInquiryStatus('');
  }, [matchId]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    if (!isOpen) return;
        const controller = new AbortController();
    const params = new URLSearchParams({ country });
    if (category !== 'all') {
      const apiCategory = category === 'photo' ? 'photo' : category;
      params.set('category', apiCategory);
    }
    setPartnersLoading(true);
    setPublishedPartners([]);
    setPartnersError('');
    fetch('/api/partner-services?' + params.toString(), { signal: controller.signal })
      .then(async response => {
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(tr('Не удалось загрузить каталог партнёров.', 'Could not load the partner directory.'));
        return Array.isArray(data?.providers) ? data.providers as PublishedPartner[] : [];
      })
      .then(providers => {
        if (!controller.signal.aborted) setPublishedPartners(providers);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setPublishedPartners([]);
          setPartnersError(tr('Каталог временно недоступен. Попробуйте обновить позже.', 'The directory is temporarily unavailable. Please refresh later.'));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setPartnersLoading(false);
      });
    return () => controller.abort();
  }, [isOpen, country, category, locale]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const getFocusable = () => dialog
      ? Array.from(dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        )).filter(element => !element.closest('[aria-hidden="true"], [hidden], [inert]'))
      : [];
    getFocusable()[0]?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = getFocusable();
      if (!focusable.length) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const submitInquiry = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!inquiryProvider || !shareContact || inquiryNote.trim().length < 20 || inquiryBusy) return;
    setInquiryBusy(true);
    setInquiryLocked(true);
    setInquiryStatus('');
    const requestKey = inquiryRequestKey.current || (inquiryRequestKey.current = crypto.randomUUID());
    const submittedMatchId = inquiryMatchId.current || (inquiryMatchId.current = matchId);
    try {
      const response = await fetch('/api/partner-service-inquiries', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          applicationId: inquiryProvider.id,
          matchId: submittedMatchId,
          requestKey,
          requestNote: inquiryNote.trim(),
          serviceDate: serviceDate || null,
          shareContact: true
        })
      });
      const data = await response.json().catch(() => null);
      if (data?.inquiryId) setInquiryId(data.inquiryId);
      if (data?.deliveryStatus) setInquiryDeliveryStatus(data.deliveryStatus);
      if (!response.ok) {
        const safeToEditAndStartANewRequest = response.status === 400 ||
          (response.status === 403 && data?.error === 'verified_contact_required') ||
          (response.status === 404 && ['active_match_not_found', 'published_partner_not_found', 'partner_inquiry_not_found'].includes(data?.error)) ||
          (response.status === 409 && data?.error === 'partner_inquiry_no_longer_eligible');
        if (safeToEditAndStartANewRequest) {
          // These responses are returned before a new provider handoff can begin.
          // Clear the unused key so the user can correct the form or choose a new match.
          inquiryRequestKey.current = null;
          inquiryMatchId.current = null;
          setInquiryLocked(false);
          setInquiryId(null);
          setInquiryDeliveryStatus('');
        }
        throw new Error(response.status === 401 ? tr('Войдите в аккаунт, чтобы отправить запрос.', 'Sign in to send a request.') :
          response.status === 403 && data?.error === 'verified_contact_required' ? tr('Подтвердите email в аккаунте, чтобы передать поставщику проверенный адрес.', 'Verify your account email before sharing it with a provider.') :
          response.status === 404 ? tr('Совпадение или карточка поставщика больше недоступны. Выберите актуальное совпадение или услугу.', 'The match or provider listing is no longer available. Choose an active match or listing.') :
          response.status === 503 || response.status === 502 ? tr('Связь с поставщиком временно недоступна. Попробуйте позже.', 'Provider contact is temporarily unavailable. Please try again later.') :
          tr('Не удалось отправить запрос. Проверьте данные и попробуйте ещё раз.', 'Could not submit the request. Check the details and try again.'));
      }
      if (data?.sent === true && data?.deliveryStatus === 'sent') {
        setInquiryStatus(tr('Почтовый сервис принял письмо к обработке. Это не подтверждает доставку поставщику.', 'The email service accepted the message for processing. This does not confirm delivery to the service provider.'));
        setInquiryProvider(null);
        setInquiryNote('');
        setServiceDate('');
        setShareContact(false);
        inquiryRequestKey.current = null;
        inquiryMatchId.current = null;
        setInquiryLocked(false);
        setInquiryId(null);
        setInquiryDeliveryStatus('');
      } else if (data?.deliveryStatus === 'cancelled') {
        setInquiryStatus(tr('Запрос отменён. Письмо поставщику не отправлялось.', 'The request was cancelled. No email was sent to the provider.'));
        setInquiryProvider(null);
        setInquiryNote('');
        setServiceDate('');
        setShareContact(false);
        inquiryRequestKey.current = null;
        inquiryMatchId.current = null;
        setInquiryLocked(false);
        setInquiryId(null);
        setInquiryDeliveryStatus('');
      } else if (data?.deliveryStatus === 'reconciliation_required') {
        setInquiryStatus(tr('Результат передачи письма уточняется. Не отправляйте запрос повторно: он сохранён и передан на ручную сверку.', 'The email handoff outcome is being checked. Do not submit again: your request is saved and awaiting manual reconciliation.'));
      } else if (data?.deliveryStatus === 'sending') {
        setInquiryStatus(tr('Запрос уже обрабатывается. Не отправляйте его повторно — дождитесь обновления статуса.', 'Your request is still being processed. Do not submit it again; wait for a status update.'));
      } else if (data?.deliveryStatus === 'pending_email_configuration') {
        setInquiryStatus(tr('Запрос сохранён. Отправка письма поставщику ожидает настройки почтового сервиса; данные не потеряны.', 'Your request is saved. Email delivery is waiting for mail-service configuration; your request has not been lost.'));
      } else {
        setInquiryStatus(tr('Запрос уже обрабатывается. Повторная отправка использует тот же запрос и не создаст дубликат.', 'Your request is already processing. Retrying will reuse it and will not create a duplicate.'));
      }
    } catch (error) {
      setInquiryStatus(error instanceof Error ? error.message : tr('Не удалось отправить запрос.', 'Could not submit the request.'));
    } finally {
      setInquiryBusy(false);
    }
  };

  const cancelInquiry = async () => {
    if (!inquiryId || !inquiryLocked || inquiryBusy || !['pending', 'pending_email_configuration', 'failed'].includes(inquiryDeliveryStatus)) return;
    if (!window.confirm(tr('Отменить сохранённый запрос? Письмо ещё не принято почтовым сервисом.', 'Cancel the saved request? The email has not been accepted by the mail provider.'))) return;
    setInquiryBusy(true);
    try {
      const response = await fetch('/api/partner-service-inquiries/' + encodeURIComponent(inquiryId) + '/cancel', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        if (data?.deliveryStatus) setInquiryDeliveryStatus(data.deliveryStatus);
        throw new Error(response.status === 409
          ? tr('Отмена уже невозможна: отправка началась или требует сверки. Проверьте статус запроса.', 'Cancellation is no longer possible: sending started or the outcome needs reconciliation. Check the request status.')
          : tr('Не удалось отменить запрос. Попробуйте проверить его статус.', 'Could not cancel the request. Please check its status.'));
      }
      setInquiryStatus(tr('Запрос отменён. Письмо поставщику не отправлялось.', 'The request was cancelled. No email was sent to the provider.'));
      setInquiryProvider(null);
      setInquiryNote('');
      setServiceDate('');
      setShareContact(false);
      inquiryRequestKey.current = null;
      inquiryMatchId.current = null;
      setInquiryId(null);
      setInquiryDeliveryStatus('');
      setInquiryLocked(false);
    } catch (error) {
      setInquiryStatus(error instanceof Error ? error.message : tr('Не удалось отменить запрос.', 'Could not cancel the request.'));
    } finally {
      setInquiryBusy(false);
    }
  };

  const isLegal = category === 'legal';
  return (
    <div className="vow-modal-backdrop fixed inset-0 z-[70] bg-stone-950/90 backdrop-blur-md overflow-y-auto p-2 sm:p-5" role="dialog" aria-modal="true" aria-labelledby="partner-services-title" aria-describedby="partner-services-description">
      <div ref={dialogRef} tabIndex={-1} className="max-w-5xl mx-auto my-2 sm:my-6 rounded-3xl border border-rose-900/40 bg-stone-900 shadow-2xl overflow-hidden">
        <div className="p-4 sm:p-6 border-b border-white/10 bg-gradient-to-r from-rose-950/70 to-stone-950">
          <div className="flex items-start justify-between gap-4">
            <div className="flex gap-3">
              <div className="w-12 h-12 rounded-2xl bg-rose-600/20 text-rose-300 flex items-center justify-center"><HeartHandshake className="w-6 h-6" /></div>
              <div>
                <p className="text-[10px] uppercase tracking-[0.18em] text-rose-300 font-bold">{tr('Следующий этап для пары', 'The next step for your match')}</p>
                <h2 id="partner-services-title" className="text-xl sm:text-2xl font-black text-white">{tr('Планирование свадьбы и юридические услуги', 'Wedding planning and legal services')}</h2>
                <p id="partner-services-description" className="text-xs sm:text-sm text-stone-300 mt-1">{tr('Услуги для вас и ' + partnerName + '. Запрос отправляется только выбранному поставщику.', 'Services for you and ' + partnerName + '. Requests go only to the provider you choose.')}</p>
              </div>
            </div>
            <button type="button" onClick={onClose} className="flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-transparent bg-white/5 text-stone-300 hover:text-white focus-visible:border-rose-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300" aria-label={tr('Закрыть', 'Close')}><X className="w-5 h-5" /></button>
          </div>
          <div className="mt-4 flex gap-2 rounded-xl border border-emerald-700/30 bg-emerald-950/30 p-3 text-xs text-emerald-100">
            <LockKeyhole className="w-4 h-4 shrink-0 mt-0.5" />
            <p>{tr('Раздел появляется только внутри взаимного совпадения после этапа совместимости. Здесь показываются только партнёры, которых модератор отдельно одобрил и опубликовал. Контактные email и внутренние заметки остаются закрытыми; цены и бронирование пока не подключены.', 'This section is available only inside a mutual match after compatibility. It shows partners separately approved and published by moderators. Contact emails and internal notes remain private; payments and bookings are not enabled.')}</p>
          </div>
        </div>

        <div className="p-4 sm:p-6">
          <div className="mb-4">
            <label className="block text-xs text-stone-400 mb-1.5" htmlFor="service-country">{tr('Страна, для которой ищете услуги', 'Country where you need services')}</label>
            <select id="service-country" name="service-country" value={country} onChange={e => setCountry(e.target.value as CountryCode)} className="w-full sm:w-64 rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white focus-visible:border-rose-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300">
              {Object.entries(countryNames).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </select>
          </div>
          <div role="group" aria-label={tr('Фильтры категорий услуг', 'Service category filters')} className="mb-5 flex gap-2 overflow-x-auto pb-2">
            {categories.map(item => {
              const Icon = item.icon;
              return <button key={item.id} type="button" aria-pressed={category === item.id} onClick={() => setCategory(item.id)} className={`shrink-0 inline-flex min-h-11 items-center gap-2 rounded-full border px-3 py-2 text-xs font-semibold transition-colors focus-visible:border-rose-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300 ${category === item.id ? 'border-rose-500 bg-rose-600 text-white' : 'border-white/10 bg-stone-950 text-stone-300 hover:border-rose-700'}`}><Icon className="h-3.5 w-3.5" />{locale === 'ru' ? item.ru : item.en}</button>;
            })}
          </div>

          {category === 'legal' && (
            <div className="mb-5 rounded-2xl border border-sky-700/30 bg-sky-950/20 p-4">
              <div className="flex gap-2 items-start"><Scale className="w-5 h-5 text-sky-300 shrink-0" /><div><h3 className="font-bold text-white">{tr('Брачный договор — по законам конкретной страны', 'Marriage agreements follow the laws of the relevant country')}</h3><p className="text-xs text-stone-300 mt-1">{tr('Пара выбирает страну применимого права и место заключения брака. Сервис должен направлять запрос только специалистам, допущенным к соответствующей практике. Наличие диплома само по себе не подтверждает право оказывать регулируемые услуги.', 'The couple chooses the applicable legal jurisdiction and place of marriage. Requests must go only to specialists authorized to practise in that jurisdiction. A degree alone does not establish authorization to provide regulated services.')}</p></div></div>
              <div className="grid sm:grid-cols-3 gap-2 mt-3 text-[11px] text-stone-300">
                <div className="rounded-xl bg-stone-950/70 p-3"><BadgeCheck className="w-4 h-4 text-emerald-300 mb-1" /><strong className="block text-white">{tr('Проверенный статус', 'Verified status')}</strong>{tr('Ручная проверка по официальному реестру', 'Manually checked against an official register')}</div>
                <div className="rounded-xl bg-stone-950/70 p-3"><FileCheck2 className="w-4 h-4 text-emerald-300 mb-1" /><strong className="block text-white">{tr('Правовая юрисдикция', 'Legal jurisdiction')}</strong>{tr('Страна, регион и виды документов', 'Country, region and document types')}</div>
                <div className="rounded-xl bg-stone-950/70 p-3"><LockKeyhole className="w-4 h-4 text-emerald-300 mb-1" /><strong className="block text-white">{tr('Конфиденциальность', 'Privacy')}</strong>{tr('Документы пары — только специалисту после согласия', 'Couple documents go only to the specialist after consent')}</div>
              </div>
            </div>
          )}

          <section aria-labelledby="published-partners-title" className="mb-6">
            <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
              <div><h3 id="published-partners-title" className="text-base font-bold text-white">{tr('Партнёры Vow', 'Vow partners')}</h3><p className="mt-1 text-xs text-stone-400">{tr('Опубликованные карточки', 'Published listings')} · {countryNames[country]}</p></div>
              <p role="status" aria-live="polite" aria-atomic="true" className="text-xs text-stone-400">{partnersLoading ? tr('Загружаем каталог…', 'Loading directory…') : formatNumber(publishedPartners.length) + ' ' + tr('партнёров', 'partners')}</p>
            </div>
            {partnersError && <p role="alert" className="mb-3 rounded-xl border border-amber-700/30 bg-amber-950/20 p-3 text-xs text-amber-100">{partnersError}</p>}
            {!partnersLoading && !partnersError && publishedPartners.length === 0 && <p role="status" className="mb-3 rounded-xl border border-white/10 bg-stone-950/50 p-4 text-sm text-stone-400">{tr('Опубликованных партнёров для выбранного фильтра пока нет.', 'No published partners match these filters yet.')}</p>}
            {publishedPartners.length > 0 && <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {publishedPartners.map(provider => {
                const matchedCategory = provider.category === 'photography' || provider.category === 'videography' ? 'photo' : provider.category;
                const Icon = categories.find(item => item.id === matchedCategory)?.icon || HeartHandshake;
                const categoryItem = categories.find(item => item.id === matchedCategory);
                const categoryLabel = categoryItem ? (locale === 'ru' ? categoryItem.ru : categoryItem.en) : tr('Услуги', 'Services');
                return <article key={provider.id} className="rounded-2xl border border-emerald-700/30 bg-stone-950/70 p-4">
                  <div className="flex items-start justify-between gap-2"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-600/15 text-emerald-300"><Icon className="h-5 w-5" /></div><span className="rounded-full border border-emerald-700/40 bg-emerald-950/40 px-2 py-1 text-[9px] text-emerald-200">{tr('В каталоге Vow', 'In the Vow directory')}</span></div>
                  <p className="mt-3 text-[10px] uppercase tracking-wide text-stone-400">{categoryLabel} · {provider.city}, {countryNames[provider.country as CountryCode] || provider.country}</p>
                  <h4 className="mt-1 font-bold text-white">{provider.businessName}</h4>
                  <p className="mt-3 whitespace-pre-wrap break-words text-xs leading-relaxed text-stone-300">{provider.serviceDescription}</p>
                  <div className="mt-3 space-y-1 text-xs text-stone-300">
                    {provider.priceFrom !== null && provider.priceFrom !== undefined && <p><strong className="text-white">{tr('Ориентир:', 'Starting price:')}</strong> {tr('от', 'from')} {formatNumber(Number(provider.priceFrom))} {provider.priceCurrency}</p>}
                    {provider.serviceLanguages?.length > 0 && <p><strong className="text-white">{tr('Языки:', 'Languages:')}</strong> {provider.serviceLanguages.join(', ')}</p>}
                    {provider.availabilityNote && <p><strong className="text-white">{tr('Доступность:', 'Availability:')}</strong> {provider.availabilityNote}</p>}
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button type="button" onClick={() => { if (inquiryLocked) return; inquiryRequestKey.current = null; inquiryMatchId.current = null; setInquiryProvider(provider); setInquiryStatus(''); setInquiryNote(''); setServiceDate(''); setShareContact(false); setInquiryLocked(false); }} disabled={inquiryLocked} className="inline-flex min-h-11 items-center rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300">{tr('Запросить предложение', 'Request a quote')}</button>
                    {provider.website && <a href={provider.website} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-lg border border-emerald-700/40 px-3 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-950/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300">{tr('Открыть сайт исполнителя', 'Open provider website')} <ChevronRight className="ml-1 h-3.5 w-3.5" /></a>}
                  </div>
                </article>;
              })}
            </div>}
          </section>

          {inquiryStatus && <p role="status" aria-live="polite" className="mt-4 rounded-xl border border-emerald-700/30 bg-emerald-950/20 p-3 text-sm text-emerald-100">{inquiryStatus}</p>}
          {inquiryProvider && <form onSubmit={submitInquiry} className="mt-4 space-y-3 rounded-2xl border border-emerald-700/30 bg-stone-950/70 p-4">
            <div><h3 className="font-bold text-white">{tr('Запрос для ' + inquiryProvider.businessName, 'Request for ' + inquiryProvider.businessName)}</h3><p className="mt-1 text-xs text-stone-300">{tr('Опишите, что вам нужно. Не указывайте паспортные, платёжные или другие чувствительные данные.', 'Describe what you need. Do not include identity, payment or other sensitive information.')}</p></div>
            <label className="block text-xs font-semibold text-stone-200">{tr('Сообщение поставщику', 'Message to provider')}
              <textarea required minLength={20} maxLength={2000} aria-describedby="partner-inquiry-note-count" value={inquiryNote} disabled={inquiryLocked} onChange={event => setInquiryNote(event.target.value)} rows={4} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-900 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300" placeholder={tr('Например: хотим узнать цену и свободные даты для фотосъёмки.', 'For example: we would like to know the price and available dates for a photo session.')} />
              <span id="partner-inquiry-note-count" className="mt-1 block text-right text-[11px] font-normal text-stone-400">{inquiryNote.length}/2000</span>
            </label>
            <label className="block text-xs font-semibold text-stone-200">{tr('Желаемая дата (необязательно)', 'Preferred date (optional)')}
              <input type="date" value={serviceDate} disabled={inquiryLocked} onChange={event => setServiceDate(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-white/10 bg-stone-900 px-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300" />
            </label>
            <label className="flex items-start gap-2 text-xs leading-relaxed text-stone-200"><input required type="checkbox" checked={shareContact} disabled={inquiryLocked} onChange={event => setShareContact(event.target.checked)} className="mt-0.5 h-4 w-4 accent-emerald-500" /><span>{tr('Я согласен(на) передать поставщику моё имя, email, желаемую дату и сообщение для ответа на запрос. Имя, контакты и переписка второго участника не передаются.', 'I consent to sharing my name, email, preferred date and message with this provider so they can respond. The other match participant\'s name, contact details and messages will not be shared.')}</span></label>
            <div className="flex flex-wrap gap-2"><button type="submit" disabled={inquiryBusy || !shareContact || inquiryNote.trim().length < 20} className="min-h-11 rounded-lg bg-emerald-700 px-4 py-2 text-xs font-bold text-white disabled:opacity-50">{inquiryBusy ? tr('Отправляем…', 'Sending…') : inquiryLocked ? tr('Проверить статус / безопасно повторить', 'Check status / safely retry') : tr('Отправить запрос', 'Send request')}</button>{inquiryLocked && inquiryId && ['pending', 'pending_email_configuration', 'failed'].includes(inquiryDeliveryStatus) && <button type="button" onClick={() => void cancelInquiry()} disabled={inquiryBusy} className="min-h-11 rounded-lg border border-rose-500/40 px-4 py-2 text-xs text-rose-200 disabled:opacity-50">{tr('Отменить сохранённый запрос', 'Cancel queued request')}</button>}<button type="button" onClick={() => setInquiryProvider(null)} disabled={inquiryBusy || inquiryLocked} className="min-h-11 rounded-lg border border-white/15 px-4 py-2 text-xs text-stone-200">{tr('Отмена', 'Cancel')}</button></div>
          </form>}
          <div className="mt-5 grid md:grid-cols-2 gap-3">
            <div className="rounded-2xl border border-white/10 bg-stone-950/60 p-4">
              <div className="flex items-center gap-2 text-white font-bold text-sm"><Wallet className="w-4 h-4 text-rose-300" /> {tr('Как сервис сможет зарабатывать', 'How the service can earn revenue')}</div>
              <ul className="mt-2 list-disc pl-5 space-y-1 text-xs text-stone-300"><li>{tr('Платная подписка поставщика за профиль и инструменты заявок.', 'Provider subscriptions for profiles and inquiry tools.')}</li><li>{tr('Комиссия с бронирования/заказа — только по договору и после подключения платежей.', 'Booking/order commissions only under contract and after payments are enabled.')}</li><li>{tr('Платное продвижение с явной маркировкой рекламы, без влияния на юридическую проверку.', 'Paid promotion with clear ad labels and no influence on legal verification.')}</li></ul>
            </div>
            <div className="rounded-2xl border border-amber-700/30 bg-amber-950/20 p-4">
              <div className="flex items-center gap-2 text-amber-200 font-bold text-sm"><AlertTriangle className="w-4 h-4" /> {tr('До запуска обязательно', 'Required before launch')}</div>
              <p className="text-xs text-stone-300 mt-2">{tr('Проверка документов администратором, безопасное хранилище, журнал проверок, сроки повторной проверки, жалобы и блокировка профиля. Оплата, договоры и передача документов в этом прототипе не работают.', 'Administrator document review, secure storage, review logs, re-verification deadlines, reporting and profile suspension. Payments, contracts and document transfer are not active in this prototype.')}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
