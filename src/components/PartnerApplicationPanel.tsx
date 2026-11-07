import React, { useState } from 'react';
import { useLocale } from '../i18n/LocaleProvider.tsx';

const categories = [
  ['cafe', 'Кафе и рестораны', 'Cafes and restaurants'],
  ['photography', 'Фотографы', 'Photographers'],
  ['dress', 'Свадебные платья', 'Wedding dresses'],
  ['videography', 'Видеографы', 'Videographers'],
  ['venue', 'Площадки для мероприятий', 'Event venues'],
  ['host', 'Ведущие и тамада', 'Hosts and MCs'],
  ['beauty', 'Свадебный образ и красота', 'Bridal beauty'],
  ['legal', 'Юридические услуги', 'Legal services'],
  ['transport', 'Транспорт', 'Transport'],
  ['other', 'Другое', 'Other']
] as const;

type Application = {
  category: string;
  businessName: string;
  contactName: string;
  contactEmail: string;
  country: string;
  city: string;
  website: string;
  serviceDescription: string;
  priceFrom: string;
  priceCurrency: string;
  serviceLanguages: string;
  availabilityNote: string;
};

const emptyApplication: Application = {
  category: 'cafe',
  businessName: '',
  contactName: '',
  contactEmail: '',
  country: '',
  city: '',
  website: '',
  serviceDescription: '',
  priceFrom: '',
  priceCurrency: 'USD',
  serviceLanguages: '',
  availabilityNote: ''
};

export const PartnerApplicationPanel: React.FC = () => {
  const { locale } = useLocale();
  const tr = (ru: string, en: string) => locale === 'ru' ? ru : en;
  const [application, setApplication] = useState<Application>(emptyApplication);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const update = (key: keyof Application, value: string) =>
    setApplication(current => ({ ...current, [key]: value }));

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setNotice('');
    try {
      const response = await fetch('/api/partner-applications', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(application)
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        const messages: Record<string, string> = {
          invalid_partner_application: tr('Проверьте заполненные поля и адрес сайта.', 'Check the form fields and website address.'),
          too_many_partner_applications: tr('Слишком много заявок. Попробуйте отправить позже.', 'Too many applications. Please try again later.'),
          partner_application_unavailable: tr('Приём заявок временно недоступен.', 'Partner applications are temporarily unavailable.')
        };
        throw new Error(messages[result?.error] || tr('Не удалось отправить заявку. Попробуйте позже.', 'Could not submit the application. Please try again.'));
      }
      setSubmitted(true);
      setNotice(tr('Заявка отправлена. Команда Vow свяжется с вами после первичной проверки.', 'Application submitted. The Vow team will contact you after an initial review.'));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : tr('Не удалось отправить заявку.', 'Could not submit the application.'));
    } finally {
      setBusy(false);
    }
  };

  const fieldClass = 'mt-1 min-h-11 w-full rounded-xl border border-white/10 bg-stone-950 px-3 py-2 text-sm text-white placeholder:text-stone-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300';
  const labelClass = 'block text-xs font-medium text-stone-300';

  return (
    <section className="vow-screen mx-auto mt-4 w-full max-w-xl rounded-3xl border border-emerald-500/20 bg-stone-900/80 p-4 sm:p-5">
      <p className="text-[10px] uppercase tracking-[0.2em] text-emerald-300">{tr('Партнёрам Vow', 'Vow partners')}</p>
      <h3 className="mt-1 text-lg font-bold text-white">{tr('Предложить услугу парам', 'Offer a service to couples')}</h3>
      <p className="mt-2 text-sm leading-relaxed text-stone-300">
        {tr('Кафе, фотографы, площадки и другие специалисты могут подать заявку на проверку. Команда проверит заявку и свяжется с вами; отправка формы не публикует карточку автоматически и не создаёт договор, бронь или оплату.', 'Cafes, photographers, venues and other providers can apply for review. Our team will review the application and contact you. Submitting this form does not automatically publish a listing or create a contract, booking or payment.')}
      </p>
      {submitted ? (
        <div role="status" aria-live="polite" className="mt-4 rounded-2xl border border-emerald-500/30 bg-emerald-950/30 p-4 text-sm text-emerald-100">
          {notice}
        </div>
      ) : (
        <form onSubmit={event => void submit(event)} className="mt-4 space-y-3">
          <div className="grid gap-3 min-[420px]:grid-cols-2">
            <label className={labelClass}>{tr('Категория', 'Category')}
              <select required value={application.category} onChange={event => update('category', event.target.value)} className={fieldClass}>
                {categories.map(([value, labelRu, labelEn]) => <option key={value} value={value}>{locale === 'ru' ? labelRu : labelEn}</option>)}
              </select>
            </label>
            <label className={labelClass}>{tr('Название бизнеса', 'Business name')}
              <input required minLength={2} maxLength={160} autoComplete="organization" value={application.businessName} onChange={event => update('businessName', event.target.value)} className={fieldClass} />
            </label>
            <label className={labelClass}>{tr('Контактное лицо', 'Contact person')}
              <input required minLength={2} maxLength={120} autoComplete="name" value={application.contactName} onChange={event => update('contactName', event.target.value)} className={fieldClass} />
            </label>
            <label className={labelClass}>{tr('Рабочий email', 'Business email')}
              <input required type="email" maxLength={254} autoComplete="email" value={application.contactEmail} onChange={event => update('contactEmail', event.target.value)} className={fieldClass} />
            </label>
            <label className={labelClass}>{tr('Страна', 'Country')}
              <select required value={application.country} onChange={event => update('country', event.target.value)} className={fieldClass}>
                <option value="">{tr('Выберите страну', 'Select a country')}</option>
                <option value="GE">{tr('Грузия', 'Georgia')}</option>
                <option value="RU">{tr('Россия', 'Russia')}</option>
                <option value="KZ">{tr('Казахстан', 'Kazakhstan')}</option>
                <option value="AM">{tr('Армения', 'Armenia')}</option>
              </select>
            </label>
            <label className={labelClass}>{tr('Город', 'City')}
              <input required maxLength={120} autoComplete="address-level2" value={application.city} onChange={event => update('city', event.target.value)} className={fieldClass} />
            </label>
          </div>
          <label className={labelClass}>{tr('Сайт или публичная страница (необязательно)', 'Website or public page (optional)')}
            <input type="url" maxLength={500} placeholder="https://example.com" value={application.website} onChange={event => update('website', event.target.value)} className={fieldClass} />
          </label>
          <div className="grid gap-3 min-[420px]:grid-cols-2">
            <label className={labelClass}>{tr('Цена от (необязательно)', 'Starting price (optional)')}
              <input type="number" min="0" max="10000000" step="0.01" inputMode="decimal" placeholder="{tr('Например, 150', 'For example, 150')}" value={application.priceFrom} onChange={event => update('priceFrom', event.target.value)} className={fieldClass} />
            </label>
            <label className={labelClass}>{tr('Валюта цены', 'Price currency')}
              <select value={application.priceCurrency} onChange={event => update('priceCurrency', event.target.value)} className={fieldClass}>
                <option value="USD">USD · {tr('доллар США', 'US dollar')}</option><option value="GEL">GEL · {tr('лари', 'lari')}</option><option value="EUR">EUR · {tr('евро', 'euro')}</option><option value="RUB">RUB · {tr('рубль', 'ruble')}</option><option value="KZT">KZT · {tr('тенге', 'tenge')}</option><option value="AMD">AMD · {tr('драм', 'dram')}</option>
              </select>
            </label>
            <label className={labelClass}>{tr('Языки обслуживания (через запятую)', 'Service languages (comma-separated)')}
              <input maxLength={500} aria-describedby="partner-languages-count" placeholder="{tr('Русский, English', 'English, Russian')}" value={application.serviceLanguages} onChange={event => update('serviceLanguages', event.target.value)} className={fieldClass} />
              <span id="partner-languages-count" className="mt-1 block text-right text-[11px] text-stone-400" aria-live="polite">{application.serviceLanguages.length}/500</span>
            </label>
            <label className={labelClass}>{tr('Доступность / сезон (необязательно)', 'Availability / season (optional)')}
              <input maxLength={500} aria-describedby="partner-availability-count" placeholder="{tr('Например: по предварительной записи', 'For example: by appointment')}" value={application.availabilityNote} onChange={event => update('availabilityNote', event.target.value)} className={fieldClass} />
              <span id="partner-availability-count" className="mt-1 block text-right text-[11px] text-stone-400" aria-live="polite">{application.availabilityNote.length}/500</span>
            </label>
          </div>
          <label className={labelClass}>{tr('Какие услуги вы оказываете?', 'What services do you provide?')}
            <textarea required minLength={20} maxLength={2000} rows={4} aria-describedby="partner-description-count" value={application.serviceDescription} onChange={event => update('serviceDescription', event.target.value)} className={fieldClass + ' resize-y'} />
            <span id="partner-description-count" className="mt-1 block text-right text-[11px] text-stone-400" aria-live="polite">{application.serviceDescription.length}/2000</span>
          </label>
          <p className="text-xs leading-relaxed text-stone-400">
            {tr('Не прикладывайте паспортные, платёжные или другие чувствительные документы. Если они понадобятся для проверки, команда запросит их отдельно безопасным способом.', 'Do not attach identity, payment or other sensitive documents. If verification requires them, our team will request them separately through a secure channel.')}
          </p>
          {notice && <p role="status" aria-live="polite" className="rounded-xl border border-rose-500/20 bg-rose-950/20 p-3 text-xs text-rose-100">{notice}</p>}
          <button type="submit" disabled={busy} className="min-h-11 w-full rounded-xl bg-emerald-700 px-4 py-3 text-sm font-bold text-white hover:bg-emerald-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:opacity-50">
            {busy ? tr('Отправка…', 'Submitting…') : tr('Отправить заявку на проверку', 'Submit application for review')}
          </button>
        </form>
      )}
    </section>
  );
};
