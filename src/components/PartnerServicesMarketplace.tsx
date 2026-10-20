import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Scale, Camera, Shirt, Music2, MapPin, ShieldCheck,
  FileCheck2, LockKeyhole, HeartHandshake, BadgeCheck,
  ChevronRight, Wallet, CheckCircle2, AlertTriangle
} from 'lucide-react';

type ServiceCategory = 'all' | 'legal' | 'dress' | 'photo' | 'host' | 'venue' | 'beauty';
type CountryCode = 'GE' | 'RU' | 'KZ' | 'AM' | 'OTHER';

interface ProviderExample {
  id: string;
  name: string;
  category: Exclude<ServiceCategory, 'all'>;
  title: string;
  description: string;
  countries: CountryCode[];
  price: string;
  verificationLabel: string;
}

const providerExamples: ProviderExample[] = [
  { id: 'legal-demo', name: 'Пример юридического партнёра', category: 'legal', title: 'Брачный договор и семейное право', description: 'Подбор юриста по выбранной стране и правовой юрисдикции пары.', countries: ['GE'], price: 'Цена после запроса', verificationLabel: 'Демо-карточка · документы не проверены' },
  { id: 'photo-demo', name: 'Пример фотографа', category: 'photo', title: 'Свадебная фотосъёмка', description: 'Портфолио, стиль съёмки, длительность и состав пакета.', countries: ['GE', 'RU'], price: 'Цена после запроса', verificationLabel: 'Демо-карточка · не реальный исполнитель' },
  { id: 'dress-demo', name: 'Пример салона аренды', category: 'dress', title: 'Свадебные платья в аренду', description: 'Размеры, примерки, залог, сроки аренды и условия возврата.', countries: ['GE'], price: 'Цена после запроса', verificationLabel: 'Демо-карточка · не реальный поставщик' },
  { id: 'host-demo', name: 'Пример ведущего', category: 'host', title: 'Ведущий / тамада', description: 'Языки, стиль программы, длительность и отзывы после проверки.', countries: ['GE', 'RU', 'KZ'], price: 'Цена после запроса', verificationLabel: 'Демо-карточка · не реальный исполнитель' },
  { id: 'venue-demo', name: 'Пример площадки', category: 'venue', title: 'Банкетные площадки', description: 'Вместимость, меню, дата, депозит и условия отмены.', countries: ['GE'], price: 'Цена после запроса', verificationLabel: 'Демо-карточка · не реальная площадка' },
  { id: 'beauty-demo', name: 'Пример стилиста', category: 'beauty', title: 'Макияж и свадебная причёска', description: 'Портфолио, пробный образ, выезд и состав пакета.', countries: ['GE', 'RU'], price: 'Цена после запроса', verificationLabel: 'Демо-карточка · не реальный исполнитель' }
];

const categories: Array<{ id: ServiceCategory; label: string; icon: React.ElementType }> = [
  { id: 'all', label: 'Все услуги', icon: HeartHandshake },
  { id: 'legal', label: 'Юристы', icon: Scale },
  { id: 'dress', label: 'Платья', icon: Shirt },
  { id: 'photo', label: 'Фото / видео', icon: Camera },
  { id: 'host', label: 'Ведущие', icon: Music2 },
  { id: 'venue', label: 'Площадки', icon: MapPin },
  { id: 'beauty', label: 'Образ', icon: SparklesIcon }
];

function SparklesIcon(props: React.ComponentProps<'svg'>) {
  return <HeartHandshake {...props} />;
}

const countryNames: Record<CountryCode, string> = {
  GE: 'Грузия',
  RU: 'Россия',
  KZ: 'Казахстан',
  AM: 'Армения',
  OTHER: 'Другая страна'
};

interface PartnerServicesMarketplaceProps {
  isOpen: boolean;
  onClose: () => void;
  coupleNames: string;
  compatibilityScore: number;
}

export const PartnerServicesMarketplace: React.FC<PartnerServicesMarketplaceProps> = ({
  isOpen, onClose, coupleNames, compatibilityScore
}) => {
  const [category, setCategory] = useState<ServiceCategory>('all');
  const [country, setCountry] = useState<CountryCode>('GE');
  const [showProviderForm, setShowProviderForm] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [providerType, setProviderType] = useState<'lawyer' | 'advocate' | 'wedding'>('lawyer');
  const [providerCountry, setProviderCountry] = useState<CountryCode>('GE');
  const [providerName, setProviderName] = useState('');
  const [providerEmail, setProviderEmail] = useState('');
  const [practice, setPractice] = useState('');
  const [documentNote, setDocumentNote] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const isAvailable = (element: HTMLElement) => {
      const style = window.getComputedStyle(element);
      return element.isConnected
        && element.getClientRects().length > 0
        && style.visibility !== 'hidden'
        && style.display !== 'none'
        && !element.matches(':disabled')
        && !element.closest('[aria-hidden="true"], [hidden], [inert]');
    };
    const getFocusable = () => dialog
      ? Array.from(dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        )).filter(element => element.tabIndex >= 0 && isAvailable(element))
      : [];
    (getFocusable()[0] ?? dialog)?.focus();

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
      if (previouslyFocused && isAvailable(previouslyFocused)) previouslyFocused.focus();
    };
  }, [isOpen]);

  const filtered = useMemo(() => providerExamples.filter(p =>
    (category === 'all' || p.category === category) && p.countries.includes(country)
  ), [category, country]);

  if (!isOpen) return null;

  const handleSubmitProvider = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const nameInput = form.querySelector<HTMLInputElement>('#provider-name');
    const practiceInput = form.querySelector<HTMLInputElement>('#provider-practice');
    if (!nameInput || !practiceInput) return;

    const trimmedName = nameInput.value.trim();
    const trimmedPractice = practiceInput.value.trim();
    nameInput.setCustomValidity(trimmedName ? '' : 'Введите имя специалиста или название организации.');
    practiceInput.setCustomValidity(trimmedPractice ? '' : 'Укажите специализацию или услуги и регионы работы.');
    if (!form.reportValidity()) return;

    setProviderName(trimmedName);
    setPractice(trimmedPractice);
    setSubmitted(true);
  };

  return (
    <div id="partner-services-dialog" className="vow-modal-backdrop fixed inset-0 z-[70] bg-stone-950/90 backdrop-blur-md overflow-y-auto p-2 sm:p-5" role="dialog" aria-modal="true" aria-labelledby="partner-services-title">
      <div ref={dialogRef} tabIndex={-1} className="vow-partner-services-marketplace max-w-5xl mx-auto my-2 sm:my-6 rounded-3xl border border-rose-900/40 bg-stone-900 shadow-2xl overflow-hidden">
        <div className="p-4 sm:p-6 border-b border-white/10 bg-gradient-to-r from-rose-950/70 to-stone-950">
          <div className="flex items-start justify-between gap-4">
            <div className="flex gap-3">
              <div className="w-12 h-12 rounded-2xl bg-rose-600/20 text-rose-300 flex items-center justify-center"><HeartHandshake className="w-6 h-6" aria-hidden="true" /></div>
              <div>
                <p className="text-[10px] uppercase tracking-[0.18em] text-rose-300 font-bold">Следующий этап для пары</p>
                <h2 id="partner-services-title" className="text-xl sm:text-2xl font-black text-white">Планирование свадьбы и юридические услуги</h2>
                <p className="text-xs sm:text-sm text-stone-300 mt-1">Для пары: {coupleNames} · индекс совместимости {compatibilityScore}%</p>
              </div>
            </div>
            <button type="button" onClick={onClose} className="flex min-h-11 min-w-11 items-center justify-center rounded-xl bg-white/5 text-stone-300 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300" aria-label="Закрыть"><X className="w-5 h-5" aria-hidden="true" /></button>
          </div>
          <div className="mt-4 flex gap-2 rounded-xl border border-emerald-700/30 bg-emerald-950/30 p-3 text-xs text-emerald-100">
            <LockKeyhole className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <p>Раздел появляется только внутри взаимного совпадения после этапа совместимости. Сейчас это демонстрация каталога: исполнители, цены, документы и оплата не подключены.</p>
          </div>
        </div>

        <div className="p-4 sm:p-6">
          <div className="flex flex-col sm:flex-row gap-3 sm:items-end sm:justify-between mb-4">
            <div>
              <label className="block text-xs text-stone-400 mb-1.5" htmlFor="service-country">Страна, для которой ищете услуги</label>
              <select id="service-country" name="service-country" autoComplete="country-name" value={country} onChange={e => setCountry(e.target.value as CountryCode)} className="w-full sm:w-64 min-h-11 rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300">
                {Object.entries(countryNames).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              </select>
            </div>
            <button type="button" aria-expanded={showProviderForm} aria-controls="provider-application-form" onClick={() => { setShowProviderForm(v => !v); setSubmitted(false); }} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-rose-500/40 bg-rose-600/10 px-4 py-3 text-xs font-bold text-rose-200 hover:bg-rose-600/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300">
              <FileCheck2 className="w-4 h-4" aria-hidden="true" /> Я предоставляю услуги
            </button>
          </div>

          <div role="group" aria-label="Категории услуг" className="flex gap-2 overflow-x-auto pb-2 mb-5">
            {categories.map(item => {
              const Icon = item.icon;
              return <button key={item.id} type="button" aria-pressed={category === item.id} onClick={() => setCategory(item.id)} className={`min-h-11 shrink-0 inline-flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300 ${category === item.id ? 'border-rose-500 bg-rose-600 text-white' : 'border-white/10 bg-stone-950 text-stone-300 hover:border-rose-700'}`}><Icon className="w-3.5 h-3.5" aria-hidden="true" />{item.label}</button>;
            })}
          </div>

          {showProviderForm && (
            <form id="provider-application-form" onSubmit={handleSubmitProvider} className="mb-6 rounded-2xl border border-rose-700/30 bg-stone-950/70 p-4 sm:p-5">
              <h3 className="font-bold text-white mb-1">Заявка поставщика услуг</h3>
              <p className="text-xs text-stone-400 mb-4">Заявка только демонстрирует будущий процесс. Не вводите паспортные данные и не прикрепляйте документы в прототипе.</p>
              {submitted ? (
                <div role="status" aria-live="polite" className="rounded-xl border border-emerald-700/30 bg-emerald-950/30 p-4 text-sm text-emerald-200"><CheckCircle2 className="inline w-4 h-4 mr-2" aria-hidden="true" />Демо-заявка проверена локально. Она не отправлена и документы не проверялись.</div>
              ) : (
                <>
                  <div className="grid sm:grid-cols-2 gap-3">
                    <div><label className="block text-xs text-stone-400 mb-1" htmlFor="provider-type">Тип поставщика</label><select id="provider-type" name="provider-type" value={providerType} onChange={e => setProviderType(e.target.value as typeof providerType)} className="w-full min-h-11 rounded-xl border border-white/10 bg-stone-900 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"><option value="lawyer">Юрист по семейному праву</option><option value="advocate">Адвокат (если статус предусмотрен законом страны)</option><option value="wedding">Свадебные услуги</option></select></div>
                    <div><label className="block text-xs text-stone-400 mb-1" htmlFor="provider-country">Страна допуска / работы</label><select id="provider-country" name="provider-country" autoComplete="country-name" value={providerCountry} onChange={e => setProviderCountry(e.target.value as CountryCode)} className="w-full min-h-11 rounded-xl border border-white/10 bg-stone-900 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300">{Object.entries(countryNames).map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></div>
                    <div><label className="block text-xs text-stone-400 mb-1" htmlFor="provider-name">Имя / название организации</label><input id="provider-name" name="provider-name" required maxLength={120} autoComplete="organization" autoCapitalize="words" value={providerName} onChange={e => { e.target.setCustomValidity(''); e.target.removeAttribute('aria-invalid'); setProviderName(e.target.value); }} className="w-full min-h-11 rounded-xl border border-white/10 bg-stone-900 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300" placeholder="Имя специалиста или компании" /></div>
                    <div><label className="block text-xs text-stone-400 mb-1" htmlFor="provider-email">Рабочий email</label><input id="provider-email" name="provider-email" required type="email" inputMode="email" maxLength={254} autoComplete="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={providerEmail} onChange={e => { e.target.setCustomValidity(''); e.target.removeAttribute('aria-invalid'); setProviderEmail(e.target.value); }} className="w-full min-h-11 rounded-xl border border-white/10 bg-stone-900 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300" placeholder="name@example.com" /></div>
                    <div className="sm:col-span-2"><label className="block text-xs text-stone-400 mb-1" htmlFor="provider-practice">{providerType === 'wedding' ? 'Услуги и регионы работы' : 'Специализация и правовая юрисдикция'}</label><input id="provider-practice" name="provider-practice" required maxLength={500} autoCapitalize="sentences" value={practice} onChange={e => { e.target.setCustomValidity(''); e.target.removeAttribute('aria-invalid'); setPractice(e.target.value); }} className="w-full min-h-11 rounded-xl border border-white/10 bg-stone-900 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300" placeholder={providerType === 'wedding' ? 'Фото, видео, аренда платья, ведущий…' : 'Семейное право, брачные договоры, страна/регион…'} /></div>
                    {providerType !== 'wedding' && <div className="sm:col-span-2 rounded-xl border border-amber-700/30 bg-amber-950/20 p-3">
                      <p className="text-xs font-bold text-amber-200 flex items-center gap-2"><ShieldCheck className="w-4 h-4" aria-hidden="true" /> Обязательная проверка юридического специалиста</p>
                      <ul className="list-disc pl-5 mt-2 space-y-1 text-xs text-stone-300">
                        <li>Удостоверение личности представителя и подтверждение личности организации.</li>
                        <li>Диплом о юридическом образовании и проверка учебного заведения.</li>
                        <li>Действующая лицензия, членство в палате/реестре или статус адвоката — если этого требует выбранная страна.</li>
                        <li>Номер и ссылка на официальный реестр, специализация, страны и виды услуг, которые специалист вправе оказывать.</li>
                      </ul>
                      <label htmlFor="provider-document-note" className="block text-xs text-stone-400 mt-3 mb-1">Ссылка на официальный реестр / номер документа (не загружайте файл в демо)</label>
                      <input id="provider-document-note" name="provider-document-reference" type="text" maxLength={500} autoCapitalize="none" autoCorrect="off" spellCheck={false} value={documentNote} onChange={e => { e.target.setCustomValidity(''); e.target.removeAttribute('aria-invalid'); setDocumentNote(e.target.value); }} className="w-full min-h-11 rounded-xl border border-white/10 bg-stone-900 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300" placeholder="Реестр, номер лицензии или диплома" />
                    </div>}
                  </div>
                  <button type="submit" className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl bg-rose-600 px-4 py-3 text-sm font-bold text-white hover:bg-rose-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"><FileCheck2 className="w-4 h-4" aria-hidden="true" /> Проверить форму (демо)</button>
                </>
              )}
            </form>
          )}

          {category === 'legal' && (
            <div className="mb-5 rounded-2xl border border-sky-700/30 bg-sky-950/20 p-4">
              <div className="flex gap-2 items-start"><Scale className="w-5 h-5 text-sky-300 shrink-0" aria-hidden="true" /><div><h3 className="font-bold text-white">Брачный договор — по законам конкретной страны</h3><p className="text-xs text-stone-300 mt-1">Пара выбирает страну применимого права и место заключения брака. Сервис должен направлять запрос только специалистам, допущенным к соответствующей практике. Наличие диплома само по себе не подтверждает право оказывать регулируемые услуги.</p></div></div>
              <div className="grid sm:grid-cols-3 gap-2 mt-3 text-[11px] text-stone-300">
                <div className="rounded-xl bg-stone-950/70 p-3"><BadgeCheck className="w-4 h-4 text-emerald-300 mb-1" aria-hidden="true" /><strong className="block text-white">Проверенный статус</strong>Ручная проверка по официальному реестру</div>
                <div className="rounded-xl bg-stone-950/70 p-3"><FileCheck2 className="w-4 h-4 text-emerald-300 mb-1" aria-hidden="true" /><strong className="block text-white">Правовая юрисдикция</strong>Страна, регион и виды документов</div>
                <div className="rounded-xl bg-stone-950/70 p-3"><LockKeyhole className="w-4 h-4 text-emerald-300 mb-1" aria-hidden="true" /><strong className="block text-white">Конфиденциальность</strong>Документы пары — только специалисту после согласия</div>
              </div>
            </div>
          )}

          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{filtered.length === 0 ? 'По выбранным фильтрам демонстрационных услуг нет' : `Найдено: ${filtered.length} ${filtered.length % 10 === 1 && filtered.length % 100 !== 11 ? 'демонстрационная услуга' : filtered.length % 10 >= 2 && filtered.length % 10 <= 4 && (filtered.length % 100 < 12 || filtered.length % 100 > 14) ? 'демонстрационные услуги' : 'демонстрационных услуг'}`}</p>
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
            {filtered.map(provider => {
              const Icon = categories.find(c => c.id === provider.category)?.icon || HeartHandshake;
              return <article key={provider.id} className="rounded-2xl border border-white/10 bg-stone-950/60 p-4">
                <div className="flex items-start justify-between gap-2"><div className="w-10 h-10 rounded-xl bg-rose-600/15 text-rose-300 flex items-center justify-center"><Icon className="w-5 h-5" aria-hidden="true" /></div><span className="text-[9px] rounded-full border border-amber-700/40 bg-amber-950/40 px-2 py-1 text-amber-200">{provider.verificationLabel}</span></div>
                <h3 className="mt-3 font-bold text-white">{provider.title}</h3>
                <p className="text-xs text-stone-400 mt-1">{provider.name}</p>
                <p className="text-xs text-stone-300 mt-3 leading-relaxed">{provider.description}</p>
                <div className="mt-4 flex items-center justify-between gap-2 border-t border-white/5 pt-3"><span className="text-xs font-semibold text-stone-200">{provider.price}</span><button type="button" aria-label={`Показать услуги в категории: ${provider.title}`} onClick={() => { setShowProviderForm(false); setCategory(provider.category); }} className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-xs font-bold text-rose-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300">Ещё в категории <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" /></button></div>
              </article>;
            })}
          </div>
          {filtered.length === 0 && <div className="rounded-2xl border border-white/10 p-8 text-center text-sm text-stone-400">Для выбранной страны и категории пока нет демонстрационных карточек.</div>}

          <div className="mt-5 grid md:grid-cols-2 gap-3">
            <div className="rounded-2xl border border-white/10 bg-stone-950/60 p-4">
              <div className="flex items-center gap-2 text-white font-bold text-sm"><Wallet className="w-4 h-4 text-rose-300" aria-hidden="true" /> Как сервис сможет зарабатывать</div>
              <ul className="mt-2 list-disc pl-5 space-y-1 text-xs text-stone-300"><li>Платная подписка поставщика за профиль и инструменты заявок.</li><li>Комиссия с бронирования/заказа — только по договору и после подключения платежей.</li><li>Платное продвижение с явной маркировкой рекламы, без влияния на юридическую проверку.</li></ul>
            </div>
            <div className="rounded-2xl border border-amber-700/30 bg-amber-950/20 p-4">
              <div className="flex items-center gap-2 text-amber-200 font-bold text-sm"><AlertTriangle className="w-4 h-4" aria-hidden="true" /> До запуска обязательно</div>
              <p className="text-xs text-stone-300 mt-2">Проверка документов администратором, безопасное хранилище, журнал проверок, сроки повторной проверки, жалобы и блокировка профиля. Оплата, договоры и передача документов в этом прототипе не работают.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
