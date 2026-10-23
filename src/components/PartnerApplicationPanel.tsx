import React, { useState } from 'react';

const categories = [
  ['cafe', 'Кафе и рестораны'],
  ['photography', 'Фотографы'],
  ['videography', 'Видеографы'],
  ['venue', 'Площадки для мероприятий'],
  ['beauty', 'Свадебный образ и красота'],
  ['legal', 'Юридические услуги'],
  ['transport', 'Транспорт'],
  ['other', 'Другое']
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
};

const emptyApplication: Application = {
  category: 'cafe',
  businessName: '',
  contactName: '',
  contactEmail: '',
  country: '',
  city: '',
  website: '',
  serviceDescription: ''
};

export const PartnerApplicationPanel: React.FC = () => {
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
          invalid_partner_application: 'Проверьте заполненные поля и адрес сайта.',
          too_many_partner_applications: 'Слишком много заявок. Попробуйте отправить позже.',
          partner_application_unavailable: 'Приём заявок временно недоступен.'
        };
        throw new Error(messages[result?.error] || 'Не удалось отправить заявку. Попробуйте позже.');
      }
      setSubmitted(true);
      setNotice('Заявка отправлена. Команда Vow свяжется с вами после первичной проверки.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Не удалось отправить заявку.');
    } finally {
      setBusy(false);
    }
  };

  const fieldClass = 'mt-1 min-h-11 w-full rounded-xl border border-white/10 bg-stone-950 px-3 py-2 text-sm text-white placeholder:text-stone-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300';
  const labelClass = 'block text-xs font-medium text-stone-300';

  return (
    <section className="vow-screen mx-auto mt-4 w-full max-w-xl rounded-3xl border border-emerald-500/20 bg-stone-900/80 p-4 sm:p-5">
      <p className="text-[10px] uppercase tracking-[0.2em] text-emerald-300">Партнёрам Vow</p>
      <h3 className="mt-1 text-lg font-bold text-white">Предложить услугу парам</h3>
      <p className="mt-2 text-sm leading-relaxed text-stone-300">
        Кафе, фотографы, площадки и другие специалисты могут подать заявку на проверку. Публикация появится только после ручного одобрения; отправка формы не создаёт договор, бронь или оплату.
      </p>
      {submitted ? (
        <div role="status" aria-live="polite" className="mt-4 rounded-2xl border border-emerald-500/30 bg-emerald-950/30 p-4 text-sm text-emerald-100">
          {notice}
        </div>
      ) : (
        <form onSubmit={event => void submit(event)} className="mt-4 space-y-3">
          <div className="grid gap-3 min-[420px]:grid-cols-2">
            <label className={labelClass}>Категория
              <select required value={application.category} onChange={event => update('category', event.target.value)} className={fieldClass}>
                {categories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className={labelClass}>Название бизнеса
              <input required minLength={2} maxLength={160} autoComplete="organization" value={application.businessName} onChange={event => update('businessName', event.target.value)} className={fieldClass} />
            </label>
            <label className={labelClass}>Контактное лицо
              <input required minLength={2} maxLength={120} autoComplete="name" value={application.contactName} onChange={event => update('contactName', event.target.value)} className={fieldClass} />
            </label>
            <label className={labelClass}>Рабочий email
              <input required type="email" maxLength={254} autoComplete="email" value={application.contactEmail} onChange={event => update('contactEmail', event.target.value)} className={fieldClass} />
            </label>
            <label className={labelClass}>Страна
              <input required maxLength={100} autoComplete="country-name" value={application.country} onChange={event => update('country', event.target.value)} className={fieldClass} />
            </label>
            <label className={labelClass}>Город
              <input required maxLength={120} autoComplete="address-level2" value={application.city} onChange={event => update('city', event.target.value)} className={fieldClass} />
            </label>
          </div>
          <label className={labelClass}>Сайт или публичная страница (необязательно)
            <input type="url" maxLength={500} placeholder="https://example.com" value={application.website} onChange={event => update('website', event.target.value)} className={fieldClass} />
          </label>
          <label className={labelClass}>Какие услуги вы оказываете?
            <textarea required minLength={20} maxLength={2000} rows={4} value={application.serviceDescription} onChange={event => update('serviceDescription', event.target.value)} className={fieldClass + ' resize-y'} />
          </label>
          <p className="text-xs leading-relaxed text-stone-400">
            Не прикладывайте паспортные, платёжные или другие чувствительные документы. Если они понадобятся для проверки, команда запросит их отдельно безопасным способом.
          </p>
          {notice && <p role="status" aria-live="polite" className="rounded-xl border border-rose-500/20 bg-rose-950/20 p-3 text-xs text-rose-100">{notice}</p>}
          <button type="submit" disabled={busy} className="min-h-11 w-full rounded-xl bg-emerald-700 px-4 py-3 text-sm font-bold text-white hover:bg-emerald-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:opacity-50">
            {busy ? 'Отправка…' : 'Отправить заявку на проверку'}
          </button>
        </form>
      )}
    </section>
  );
};
