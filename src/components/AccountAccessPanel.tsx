import React, { useEffect, useState } from 'react';
import { useLocale } from '../i18n/LocaleProvider.tsx';

type AccountUser = {
  id: string;
  email: string;
  displayName: string;
  gender: 'female' | 'male';
  country: string;
  city: string;
  relationshipIntent: 'marriage_family' | 'serious_relationship' | 'family_without_marriage';
};

type AccountAccessPanelProps = { onAuthenticated: () => void };

export const AccountAccessPanel: React.FC<AccountAccessPanelProps> = ({ onAuthenticated }) => {
  const { formatDate, t } = useLocale();
  const [user, setUser] = useState<AccountUser | null>(null);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [gender, setGender] = useState<'female' | 'male'>('female');
  const [country, setCountry] = useState('Грузия');
  const [city, setCity] = useState('Тбилиси');
  const [relationshipIntent, setRelationshipIntent] = useState<'marriage_family' | 'serious_relationship' | 'family_without_marriage'>('marriage_family');
  const [familyFormat, setFamilyFormat] = useState<'marriage' | 'cohabitation' | 'open_to_both'>('open_to_both');
  const [hasChildren, setHasChildren] = useState<boolean | null>(null);
  const [wantsChildren, setWantsChildren] = useState<'yes' | 'no' | 'discuss' | 'unsure'>('discuss');
  const [childrenLivingArrangement, setChildrenLivingArrangement] = useState<'with_me' | 'shared_custody' | 'with_other_parent' | 'not_applicable' | 'prefer_to_discuss'>('not_applicable');
  const [billingStatus, setBillingStatus] = useState<{access:string;trialEndsAt:string|null;premiumUntil:string|null;paymentConfigured:boolean}|null>(null);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteNotice, setDeleteNotice] = useState('');
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [canResendVerification, setCanResendVerification] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [resetToken, setResetToken] = useState('');
  const [resetPassword, setResetPassword] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/me', { credentials: 'include' })
      .then(async response => response.ok ? response.json() : null)
      .then(async data => {
        if (!cancelled && data?.user) {
          if (data?.verificationRequired) {
        setMessage('Аккаунт создан. Проверьте почту и перейдите по ссылке для подтверждения email.');
        setPassword('');
        return;
      }
      setUser(data.user);
          const billing = await fetch('/api/billing/status', { credentials: 'include' }).then(response => response.ok ? response.json() : null).catch(() => null);
          if (!cancelled) setBillingStatus(billing);
        }
      })
      .catch(() => {});
    const params = new URLSearchParams(window.location.search);
    const verificationToken = params.get('verifyEmail');
    const passwordResetToken = params.get('resetPassword');
    if (verificationToken) {
      fetch('/api/auth/verify-email', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: verificationToken })
      }).then(async response => {
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error('This verification link is invalid or has expired. Request a new one.');
        setMessage(data?.message || 'Email verified. You can now sign in.');
        setMode('login');
      }).catch(error => setMessage(error instanceof Error ? error.message : 'Email verification failed.'));
      params.delete('verifyEmail');
      window.history.replaceState({}, '', window.location.pathname + (params.size ? '?' + params.toString() : '') + window.location.hash);
    }
    if (passwordResetToken) {
      setResetToken(passwordResetToken);
      setShowReset(true);
      params.delete('resetPassword');
      window.history.replaceState({}, '', window.location.pathname + (params.size ? '?' + params.toString() : '') + window.location.hash);
    }
    return () => { cancelled = true; };
  }, []);

  const submit = async () => {
    setBusy(true);
    setMessage('');
    setCanResendVerification(false);
    try {
      const body = mode === 'login'
        ? { email, password }
        : { email, password, displayName, birthDate, gender, country, city, relationshipIntent, familyFormat, hasChildren, wantsChildren, childrenLivingArrangement };
      const response = await fetch(mode === 'login' ? '/api/auth/login' : '/api/auth/register', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = response.status === 204 ? null : await response.json().catch(() => null);
      if (!response.ok) {
        const errors: Record<string, string> = {
          invalid_email: 'Укажите корректный email.',
          password_must_be_12_to_128_characters: 'Пароль должен содержать от 12 до 128 символов.',
          must_be_18_or_older_with_valid_birth_date: 'Регистрация доступна только совершеннолетним (18+).',
          email_already_registered: 'Этот email уже зарегистрирован. Войдите в аккаунт.',
          email_or_password_incorrect: 'Неверный email или пароль.',
          email_verification_required: 'Сначала подтвердите адрес электронной почты. Можно отправить письмо повторно.',
          email_delivery_not_configured: 'Отправка писем не настроена на сервере.',
          verification_email_delivery_failed: 'Аккаунт создан, но письмо не доставлено. Запросите повторную отправку письма.',
          valid_country_and_city_required: 'Укажите страну и город.',
          invalid_gender: 'Выберите пол.',
          children_status_required: 'Обязательно укажите, есть ли у вас дети.',
          invalid_family_format: 'Выберите подходящий формат семьи.'
        };
        if (data?.error === 'email_verification_required' || data?.error === 'verification_email_delivery_failed') setCanResendVerification(true);
        throw new Error(errors[data?.error] || 'Не удалось выполнить запрос. Проверьте данные и доступность API.');
      }
      setUser(data.user);
      const billing = await fetch('/api/billing/status', { credentials: 'include' }).then(response => response.ok ? response.json() : null).catch(() => null);
      setBillingStatus(billing);
      setMessage(mode === 'register' ? 'Аккаунт создан.' : 'Вы вошли в аккаунт.');
      setPassword('');
      onAuthenticated();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось связаться с сервером.');
    } finally {
      setBusy(false);
    }
  };

  const resendVerification = async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/auth/email-verification/resend', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email })
      });
      const data = await response.json().catch(() => null);
      setMessage(data?.message || 'Если аккаунту требуется подтверждение, письмо будет отправлено.');
      setCanResendVerification(false);
    } catch {
      setMessage('Не удалось запросить письмо. Попробуйте позже.');
    } finally { setBusy(false); }
  };

  const requestPasswordReset = async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/auth/password-reset/request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email })
      });
      const data = await response.json().catch(() => null);
      setMessage(data?.message || 'Если аккаунт существует, инструкции будут отправлены на email.');
    } catch {
      setMessage('Не удалось запросить восстановление. Попробуйте позже.');
    } finally { setBusy(false); }
  };

  const completePasswordReset = async () => {
    if (resetPassword.length < 12) {
      setMessage('Новый пароль должен содержать не менее 12 символов.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/auth/password-reset/complete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, password: resetPassword })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error === 'invalid_or_expired_token' ? 'Ссылка недействительна или срок её действия истёк.' : 'Не удалось изменить пароль.');
      setShowReset(false);
      setResetToken('');
      setResetPassword('');
      setMode('login');
      setMessage(data?.message || 'Пароль изменён. Войдите с новым паролем.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось изменить пароль.');
    } finally { setBusy(false); }
  };

  const deleteAccount = async () => {
    if (!showDeleteAccount || !deletePassword) {
      setShowDeleteAccount(true);
      setDeleteNotice('Для подтверждения введите текущий пароль.');
      return;
    }
    const confirmed = window.confirm('Удалить аккаунт? Анкета станет невидимой, данные профиля будут обезличены, а действие нельзя будет отменить.');
    if (!confirmed) return;
    setBusy(true);
    setDeleteNotice('');
    try {
      const response = await fetch('/api/account', {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: deletePassword })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const errors: Record<string, string> = {
          password_confirmation_required: 'Введите текущий пароль.',
          password_confirmation_failed: 'Пароль не подошёл. Аккаунт не удалён.'
        };
        throw new Error(errors[data?.error] || 'Не удалось удалить аккаунт.');
      }
      setUser(null);
      setBillingStatus(null);
      setDeletePassword('');
      setShowDeleteAccount(false);
      setDeleteNotice('Аккаунт удалён, персональные поля обезличены.');
      onAuthenticated();
    } catch (error) {
      setDeleteNotice(error instanceof Error ? error.message : 'Ошибка удаления аккаунта.');
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
      if (!response.ok) throw new Error('Не удалось завершить сессию.');
      setUser(null);
      setBillingStatus(null);
      setMessage('Вы вышли из аккаунта.');
      onAuthenticated();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось выйти.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mb-5 rounded-3xl border border-white/10 bg-stone-900/80 p-4 sm:p-5">
      <div className="mb-3">
        <p className="text-[10px] uppercase tracking-[0.2em] text-rose-300">{t('accountTitle')}</p>
        <h3 className="mt-1 text-lg font-bold text-white">{user ? t('signedIn') : mode === 'login' ? t('signIn') : t('createAccount')}</h3>
      </div>
      {user ? (
        <div className="flex flex-col gap-3">
          <div className="rounded-xl bg-stone-950 p-3">
            <p className="text-sm font-semibold text-white">{user.displayName}</p>
            <p className="mt-1 text-xs text-stone-400">{user.email} · {user.city}, {user.country}</p>
          </div>
          {billingStatus && user.gender === 'female' && <div className={`rounded-xl border p-3 ${billingStatus.access === 'full' ? 'border-emerald-500/20 bg-emerald-950/20' : 'border-amber-500/20 bg-amber-950/20'}`}>
            <p className="text-sm font-semibold text-white">{billingStatus.access === 'full' ? 'Полный доступ активен' : 'Пробный период завершён'}</p>
            <p className="mt-1 text-xs leading-relaxed text-stone-300">{billingStatus.trialEndsAt && billingStatus.access === 'full' ? `Бесплатный доступ до ${formatDate(billingStatus.trialEndsAt, { dateStyle: 'medium', timeStyle: 'short' })}.` : billingStatus.access !== 'full' ? 'Для платных функций понадобится Premium. Платёжный провайдер ещё не подключён, поэтому списаний сейчас нет.' : 'Подписка активна.'}</p>
          </div>}
          <button type="button" onClick={() => void logout()} disabled={busy} className="rounded-xl border border-white/10 px-4 py-3 text-sm font-semibold text-stone-200 disabled:opacity-50">{t('logout')}</button>
          <div className="rounded-xl border border-red-500/20 bg-red-950/20 p-3">
            <p className="text-sm font-semibold text-red-200">{t('deleteAccount')}</p>
            <p className="mt-1 text-xs leading-relaxed text-stone-400">{t('deleteAccountDetails')}</p>
            {showDeleteAccount && <label className="mt-3 block text-xs text-stone-300">{t('currentPassword')}<input type="password" value={deletePassword} onChange={e => setDeletePassword(e.target.value)} autoComplete="current-password" className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white" /></label>}
            <button type="button" onClick={() => { if (!showDeleteAccount) { setShowDeleteAccount(true); setDeleteNotice('Введите пароль, затем нажмите ещё раз для подтверждения удаления.'); } else { void deleteAccount(); } }} disabled={busy || (showDeleteAccount && !deletePassword)} className="mt-3 w-full rounded-xl border border-red-500/30 px-4 py-2.5 text-xs font-semibold text-red-200 disabled:opacity-50">{busy ? t('processing') : showDeleteAccount ? t('confirmDelete') : t('deleteAccount')}</button>
            {deleteNotice && <p role="status" className="mt-2 text-xs text-stone-300">{deleteNotice}</p>}
          </div>
        </div>
      ) : showReset ? (
        <div className="space-y-3">
          <p className="text-sm text-stone-300">{t('resetPasswordDetails')}</p>
          <label className="block text-xs text-stone-300">{t('newPassword')}<input type="password" value={resetPassword} onChange={event => setResetPassword(event.target.value)} minLength={12} maxLength={128} autoComplete="new-password" className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white" /></label>
          <button type="button" onClick={() => void completePasswordReset()} disabled={busy || resetPassword.length < 12} className="w-full rounded-xl bg-rose-600 px-4 py-3 text-sm font-bold text-white disabled:opacity-40">{busy ? 'Обрабатываем…' : 'Изменить пароль'}</button>
        </div>
      ) : (
        <>
          <div className="mb-3 grid grid-cols-2 gap-2">
            <button type="button" onClick={() => { setMode('login'); setMessage(''); }} className={`rounded-xl border px-3 py-2 text-xs font-semibold ${mode === 'login' ? 'border-rose-500 bg-rose-950/50 text-white' : 'border-white/10 text-stone-400'}`}>{t('signIn')}</button>
            <button type="button" onClick={() => { setMode('register'); setMessage(''); }} className={`rounded-xl border px-3 py-2 text-xs font-semibold ${mode === 'register' ? 'border-rose-500 bg-rose-950/50 text-white' : 'border-white/10 text-stone-400'}`}>{t('register')}</button>
          </div>
          <div className="space-y-3">
            {mode === 'register' && <>
              <label className="block text-xs text-stone-300">{t('profileName')}<input value={displayName} onChange={e => setDisplayName(e.target.value)} minLength={2} maxLength={80} autoComplete="name" className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white" /></label>
              <label className="block text-xs text-stone-300">{t('birthDate')}<input type="date" value={birthDate} onChange={e => setBirthDate(e.target.value)} max={new Date().toISOString().slice(0, 10)} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white" /></label>
              <label className="block text-xs text-stone-300">{t('gender')}<select value={gender} onChange={e => setGender(e.target.value as 'female' | 'male')} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white"><option value="female">{t('female')}</option><option value="male">{t('male')}</option></select></label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-xs text-stone-300">{t('countryLabel')}<input value={country} onChange={e => setCountry(e.target.value)} maxLength={100} autoComplete="country-name" className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white" /></label>
                <label className="block text-xs text-stone-300">{t('cityLabel')}<input value={city} onChange={e => setCity(e.target.value)} maxLength={120} autoComplete="address-level2" className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white" /></label>
              </div>
              <label className="block text-xs text-stone-300">{t('relationshipIntentLabel')}<select value={relationshipIntent} onChange={e => setRelationshipIntent(e.target.value as typeof relationshipIntent)} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white"><option value="marriage_family">{t('marriageFamilyOption')}</option><option value="family_without_marriage">{t('familyWithoutMarriageOption')}</option><option value="serious_relationship">{t('seriousRelationshipOption')}</option></select></label>
              <label className="block text-xs text-stone-300">{t('familyFormatLabel')}<select value={familyFormat} onChange={e => setFamilyFormat(e.target.value as typeof familyFormat)} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white"><option value="open_to_both">{t('openToMarriageAndLiving')}</option><option value="marriage">{t('officialMarriageOnly')}</option><option value="cohabitation">{t('livingTogetherOnly')}</option></select></label>
              <fieldset className="rounded-xl border border-white/10 bg-stone-950 p-3">
                <legend className="px-1 text-xs font-semibold text-white">{t('hasChildrenQuestion')} Обязательный вопрос</legend>
                <p className="mb-2 text-[10px] leading-relaxed text-stone-400">Укажите правду. Информация важна для осознанного выбора обоих партнёров.</p>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => {setHasChildren(true);setChildrenLivingArrangement('prefer_to_discuss');}} className={`rounded-lg border p-2 text-xs ${hasChildren === true ? 'border-rose-500 bg-rose-950 text-white' : 'border-white/10 text-stone-300'}`}>{t('yesChildren')}</button>
                  <button type="button" onClick={() => {setHasChildren(false);setChildrenLivingArrangement('not_applicable');}} className={`rounded-lg border p-2 text-xs ${hasChildren === false ? 'border-rose-500 bg-rose-950 text-white' : 'border-white/10 text-stone-300'}`}>{t('noChildrenAnswer')}</button>
                </div>
                {hasChildren === true && <label className="mt-3 block text-xs text-stone-300">Как организовано проживание детей<select value={childrenLivingArrangement} onChange={e => setChildrenLivingArrangement(e.target.value as typeof childrenLivingArrangement)} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white"><option value="with_me">Дети живут со мной</option><option value="shared_custody">Совместная опека / проживают по очереди</option><option value="with_other_parent">Дети живут с другим родителем</option><option value="prefer_to_discuss">Предпочитаю обсудить лично</option></select></label>}
                <label className="mt-3 block text-xs text-stone-300">Хотите ли вы детей в будущем?<select value={wantsChildren} onChange={e => setWantsChildren(e.target.value as typeof wantsChildren)} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white"><option value="yes">Да</option><option value="no">Нет</option><option value="discuss">Готов(а) обсуждать с партнёром</option><option value="unsure">Пока не уверен(а)</option></select></label>
              </fieldset>
            </>}
            <label className="block text-xs text-stone-300">{t('email')}<input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="email" className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white" /></label>
            <label className="block text-xs text-stone-300">{t('passwordMin')}<input type="password" value={password} onChange={e => setPassword(e.target.value)} minLength={12} maxLength={128} required autoComplete={mode === 'login' ? 'current-password' : 'new-password'} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white" /></label>
            <button type="button" onClick={() => void submit()} disabled={busy || !email.trim() || password.length < 12 || (mode === 'register' && (!displayName.trim() || !birthDate || !country.trim() || !city.trim() || hasChildren === null))} className="w-full rounded-xl bg-rose-600 px-4 py-3 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-40">{busy ? t('wait') : mode === 'login' ? t('signIn') : t('createAccount')}</button>
            {mode === 'login' && <div className="grid grid-cols-1 gap-2">
              <button type="button" onClick={() => void requestPasswordReset()} disabled={busy || !email.trim()} className="text-left text-xs text-rose-300 underline disabled:opacity-40">{t('resetEmailLink')}</button>
              {canResendVerification && <button type="button" onClick={() => void resendVerification()} disabled={busy || !email.trim()} className="text-left text-xs text-amber-300 underline disabled:opacity-40">{t('resendEmailVerification')}</button>}
            </div>}
          </div>
        </>
      )}
      {message && <p role="status" className="mt-3 text-xs leading-relaxed text-stone-300">{message}</p>}
      <p className="mt-3 text-[10px] leading-relaxed text-stone-500">{t('authServerNotice')}</p>
    </section>
  );
};
