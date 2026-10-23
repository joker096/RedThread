import React, { useEffect, useRef, useState } from 'react';
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

type BillingStatus = {
  access: 'full' | 'premium_required';
  trialEndsAt: string | null;
  premiumUntil: string | null;
  paymentConfigured: boolean;
};

type AccountAccessPanelProps = { onAuthenticated: () => void };

export const isAccountUser = (value: unknown): value is AccountUser => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const isBoundedString = (item: unknown, maxLength: number, required = false): item is string =>
    typeof item === 'string'
    && item.length <= maxLength
    && (!required || item.trim().length > 0);

  return isBoundedString(candidate.id, 256, true)
    && isBoundedString(candidate.email, 254, true)
    && isBoundedString(candidate.displayName, 100, true)
    && (candidate.gender === 'female' || candidate.gender === 'male')
    && isBoundedString(candidate.country, 100)
    && isBoundedString(candidate.city, 100)
    && (candidate.relationshipIntent === 'marriage_family'
      || candidate.relationshipIntent === 'serious_relationship'
      || candidate.relationshipIntent === 'family_without_marriage');
};

export const isBillingStatus = (value: unknown): value is BillingStatus => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const isOptionalDate = (item: unknown): item is string | null =>
    item === null || (typeof item === 'string' && item.length <= 40 && Number.isFinite(Date.parse(item)));

  return (candidate.access === 'full' || candidate.access === 'premium_required')
    && isOptionalDate(candidate.trialEndsAt)
    && isOptionalDate(candidate.premiumUntil)
    && typeof candidate.paymentConfigured === 'boolean';
};

export const AccountAccessPanel: React.FC<AccountAccessPanelProps> = ({ onAuthenticated }) => {
  const { formatDate, t } = useLocale();
  const [user, setUser] = useState<AccountUser | null>(null);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [gender, setGender] = useState<'female' | 'male'>('female');
  const [country, setCountry] = useState('');
  const [city, setCity] = useState('');
  const [relationshipIntent, setRelationshipIntent] = useState<'marriage_family' | 'serious_relationship' | 'family_without_marriage'>('marriage_family');
  const [familyFormat, setFamilyFormat] = useState<'marriage' | 'cohabitation' | 'open_to_both'>('open_to_both');
  const [hasChildren, setHasChildren] = useState<boolean | null>(null);
  const [wantsChildren, setWantsChildren] = useState<'yes' | 'no' | 'discuss' | 'unsure'>('discuss');
  const [childrenLivingArrangement, setChildrenLivingArrangement] = useState<'with_me' | 'shared_custody' | 'with_other_parent' | 'not_applicable' | 'prefer_to_discuss'>('not_applicable');
  const [billingStatus, setBillingStatus] = useState<BillingStatus | null>(null);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteNotice, setDeleteNotice] = useState('');
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [canResendVerification, setCanResendVerification] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [resetToken, setResetToken] = useState('');
  const [resetPassword, setResetPassword] = useState('');
  const sessionActionIdRef = useRef(0);
  const auxiliaryRequestIdRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const initialSessionActionId = sessionActionIdRef.current;
    const initialAuxiliaryRequestId = auxiliaryRequestIdRef.current;
    fetch('/api/auth/me', { credentials: 'include' })
      .then(async response => response.ok ? response.json() : null)
      .then(async data => {
        if (!cancelled && initialSessionActionId === sessionActionIdRef.current && initialAuxiliaryRequestId === auxiliaryRequestIdRef.current && data?.user) {
          if (!isAccountUser(data.user)) {
            setMessage(t('authRequestFailed'));
            return;
          }
          if (data?.verificationRequired) {
            setMessage(t('authAccountCreatedVerification'));
            setPassword('');
            return;
          }
          setUser(data.user);
          window.dispatchEvent(new Event('vow:session-changed'));
          const billing = await fetch('/api/billing/status', { credentials: 'include' }).then(response => response.ok ? response.json() : null).catch(() => null);
          if (!cancelled && initialSessionActionId === sessionActionIdRef.current && initialAuxiliaryRequestId === auxiliaryRequestIdRef.current) setBillingStatus(isBillingStatus(billing) ? billing : null);
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
        await response.json().catch(() => null);
        if (cancelled || initialAuxiliaryRequestId !== auxiliaryRequestIdRef.current) return;
        if (!response.ok) throw new Error(t('authVerificationLinkInvalid'));
        setMessage(t('authEmailVerified'));
        setMode('login');
      }).catch(error => { if (!cancelled && initialAuxiliaryRequestId === auxiliaryRequestIdRef.current) setMessage(error instanceof Error ? error.message : t('authVerificationFailed')); });
      params.delete('verifyEmail');
      window.history.replaceState({}, '', window.location.pathname + (params.size ? '?' + params.toString() : '') + window.location.hash);
    }
    if (passwordResetToken) {
      setResetToken(passwordResetToken);
      setShowReset(true);
      params.delete('resetPassword');
      window.history.replaceState({}, '', window.location.pathname + (params.size ? '?' + params.toString() : '') + window.location.hash);
    }
    return () => { cancelled = true; auxiliaryRequestIdRef.current += 1; };
  }, []);

  const submit = async () => {
    auxiliaryRequestIdRef.current += 1;
    let activeActionId = ++sessionActionIdRef.current;
    const submittedMode = mode;
    setBusy(true);
    setMessage('');
    setCanResendVerification(false);
    try {
      const body = submittedMode === 'login'
        ? { email, password }
        : { email, password, displayName, birthDate, gender, country, city, relationshipIntent, familyFormat, hasChildren, wantsChildren, childrenLivingArrangement };
      const response = await fetch(submittedMode === 'login' ? '/api/auth/login' : '/api/auth/register', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = response.status === 204 ? null : await response.json().catch(() => null);
      if (sessionActionIdRef.current !== activeActionId) return;
      if (!response.ok) {
        const errors: Record<string, string> = {
          invalid_email: t('authInvalidEmail'),
          password_must_be_12_to_128_characters: t('authPasswordLengthError'),
          must_be_18_or_older_with_valid_birth_date: t('authAdultRequired'),
          email_already_registered: t('authEmailTaken'),
          email_or_password_incorrect: t('authCredentialsInvalid'),
          email_verification_required: t('authVerifyEmailFirst'),
          email_delivery_not_configured: t('authEmailNotConfigured'),
          verification_email_delivery_failed: t('authVerificationDeliveryFailed'),
          valid_country_and_city_required: t('authCountryCityRequired'),
          invalid_gender: t('authGenderRequired'),
          children_status_required: t('authChildrenStatusRequired'),
          invalid_family_format: t('authFamilyFormatRequired')
        };
        if (data?.error === 'email_verification_required' || data?.error === 'verification_email_delivery_failed') setCanResendVerification(true);
        throw new Error(errors[data?.error] || t('authRequestFailed'));
      }
      if (!isAccountUser(data?.user)) {
        throw new Error(t('authRequestFailed'));
      }
      activeActionId = ++sessionActionIdRef.current;
      setUser(data.user);
      window.dispatchEvent(new Event('vow:session-changed'));
      const billing = await fetch('/api/billing/status', { credentials: 'include' }).then(response => response.ok ? response.json() : null).catch(() => null);
      if (sessionActionIdRef.current !== activeActionId) return;
      setBillingStatus(isBillingStatus(billing) ? billing : null);
      setMessage(submittedMode === 'register' ? t('authAccountCreated') : t('authSignedIn'));
      setPassword('');
      onAuthenticated();
    } catch (error) {
      if (sessionActionIdRef.current !== activeActionId) return;
      setMessage(error instanceof Error ? error.message : t('authConnectionFailed'));
    } finally {
      if (sessionActionIdRef.current === activeActionId) setBusy(false);
    }
  };

  const resendVerification = async () => {
    const requestId = ++auxiliaryRequestIdRef.current;
    setBusy(true);
    try {
      const response = await fetch('/api/auth/email-verification/resend', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email })
      });
      await response.json().catch(() => null);
      if (requestId !== auxiliaryRequestIdRef.current) return;
      setMessage(t('authResendGeneric'));
      setCanResendVerification(false);
    } catch {
      if (requestId !== auxiliaryRequestIdRef.current) return;
      setMessage(t('authResendFailed'));
    } finally { if (requestId === auxiliaryRequestIdRef.current) setBusy(false); }
  };

  const requestPasswordReset = async () => {
    const requestId = ++auxiliaryRequestIdRef.current;
    setBusy(true);
    try {
      const response = await fetch('/api/auth/password-reset/request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email })
      });
      await response.json().catch(() => null);
      if (requestId !== auxiliaryRequestIdRef.current) return;
      setMessage(t('authResetGeneric'));
    } catch {
      if (requestId !== auxiliaryRequestIdRef.current) return;
      setMessage(t('authResetRequestFailed'));
    } finally { if (requestId === auxiliaryRequestIdRef.current) setBusy(false); }
  };

  const completePasswordReset = async () => {
    if (resetPassword.length < 12) {
      setMessage(t('authPasswordResetMinimum'));
      return;
    }
    const requestId = ++auxiliaryRequestIdRef.current;
    setBusy(true);
    try {
      const response = await fetch('/api/auth/password-reset/complete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, password: resetPassword })
      });
      const data = await response.json().catch(() => null);
      if (requestId !== auxiliaryRequestIdRef.current) return;
      if (!response.ok) throw new Error(data?.error === 'invalid_or_expired_token' ? t('authResetLinkInvalid') : t('authPasswordChangeFailed'));
      setShowReset(false);
      setResetToken('');
      setResetPassword('');
      setMode('login');
      setMessage(t('authPasswordChanged'));
    } catch (error) {
      if (requestId !== auxiliaryRequestIdRef.current) return;
      setMessage(error instanceof Error ? error.message : t('authPasswordChangeFailed'));
    } finally {
      if (requestId === auxiliaryRequestIdRef.current) setBusy(false);
    }
  };

  const deleteAccount = async () => {
    if (!showDeleteAccount || !deletePassword) {
      setShowDeleteAccount(true);
      setDeleteNotice(t('authDeletePasswordRequired'));
      return;
    }
    const confirmed = window.confirm(t('authDeleteConfirm'));
    if (!confirmed) return;
    auxiliaryRequestIdRef.current += 1;
    const actionId = ++sessionActionIdRef.current;
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
      if (sessionActionIdRef.current !== actionId) return;
      if (!response.ok) {
        const errors: Record<string, string> = {
          password_confirmation_required: t('authDeletePasswordRequired'),
          password_confirmation_failed: t('authDeletePasswordIncorrect')
        };
        throw new Error(errors[data?.error] || t('authDeleteFailed'));
      }
      setUser(null);
      window.dispatchEvent(new Event('vow:session-changed'));
      setBillingStatus(null);
      setDeletePassword('');
      setShowDeleteAccount(false);
      setDeleteNotice(t('authDeleteSuccess'));
      onAuthenticated();
    } catch (error) {
      if (sessionActionIdRef.current !== actionId) return;
      setDeleteNotice(error instanceof Error ? error.message : t('authDeleteGenericError'));
    } finally {
      if (sessionActionIdRef.current === actionId) setBusy(false);
    }
  };

  const logout = async () => {
    auxiliaryRequestIdRef.current += 1;
    const actionId = ++sessionActionIdRef.current;
    setBusy(true);
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
      if (sessionActionIdRef.current !== actionId) return;
      if (!response.ok) throw new Error(t('authLogoutFailed'));
      setUser(null);
      window.dispatchEvent(new Event('vow:session-changed'));
      setBillingStatus(null);
      setMessage(t('authLogoutSuccess'));
      onAuthenticated();
    } catch (error) {
      if (sessionActionIdRef.current !== actionId) return;
      setMessage(error instanceof Error ? error.message : t('authLogoutFailed'));
    } finally {
      if (sessionActionIdRef.current === actionId) setBusy(false);
    }
  };

  return (
    <section aria-busy={busy} className="vow-screen mb-5 min-w-0 rounded-3xl border border-white/10 bg-stone-900/80 p-3 sm:p-5">
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
            <p className="text-sm font-semibold text-white">{billingStatus.access === 'full' ? t('authBillingFullAccess') : t('authBillingTrialEnded')}</p>
            <p className="mt-1 text-xs leading-relaxed text-stone-300">{billingStatus.trialEndsAt && billingStatus.access === 'full' ? t('authBillingFreeUntil').replace('{date}', formatDate(billingStatus.trialEndsAt, { dateStyle: 'medium', timeStyle: 'short' })) : billingStatus.access !== 'full' ? t('authBillingPremiumNotConfigured') : t('authBillingActive')}</p>
          </div>}
          <button type="button" onClick={() => void logout()} disabled={busy} className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300 min-h-11 rounded-xl border border-white/10 px-4 py-3 text-sm font-semibold text-stone-200 disabled:opacity-50">{t('logout')}</button>
          <div className="rounded-xl border border-red-500/20 bg-red-950/20 p-3">
            <p className="text-sm font-semibold text-red-200">{t('deleteAccount')}</p>
            <p className="mt-1 text-xs leading-relaxed text-stone-400">{t('deleteAccountDetails')}</p>
            {showDeleteAccount && <label className="mt-3 block text-xs text-stone-300">{t('currentPassword')}<input name="delete-account-current-password" type="password" value={deletePassword} onChange={e => setDeletePassword(e.target.value)} autoComplete="current-password" className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300" /></label>}
            <button type="button" onClick={() => { if (!showDeleteAccount) { setShowDeleteAccount(true); setDeleteNotice(t('authDeleteButtonPrompt')); } else { void deleteAccount(); } }} disabled={busy || (showDeleteAccount && !deletePassword)} className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300 mt-3 min-h-11 w-full rounded-xl border border-red-500/30 px-4 py-2.5 text-xs font-semibold text-red-200 disabled:opacity-50">{busy ? t('processing') : showDeleteAccount ? t('confirmDelete') : t('deleteAccount')}</button>
            {deleteNotice && <p role="status" aria-live="polite" aria-atomic="true" className="mt-2 text-xs text-stone-300">{deleteNotice}</p>}
          </div>
        </div>
      ) : showReset ? (
        <div className="space-y-3">
          <p className="text-sm text-stone-300">{t('resetPasswordDetails')}</p>
          <label className="block text-xs text-stone-300">{t('newPassword')}<input name="password-reset-new-password" type="password" value={resetPassword} onChange={event => setResetPassword(event.target.value)} minLength={12} maxLength={128} autoComplete="new-password" className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300" /></label>
          <button type="button" onClick={() => void completePasswordReset()} disabled={busy || resetPassword.length < 12} className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300 min-h-11 w-full rounded-xl bg-rose-600 px-4 py-3 text-sm font-bold text-white disabled:opacity-40">{busy ? t('authResetBusy') : t('changePassword')}</button>
        </div>
      ) : (
        <>
          <div className="mb-3 grid grid-cols-2 gap-2">
            <button type="button" aria-pressed={mode === 'login'} onClick={() => { setMode('login'); setMessage(''); }} className={`focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300 min-h-11 rounded-xl border px-3 py-2 text-xs font-semibold ${mode === 'login' ? 'border-rose-500 bg-rose-950/50 text-white' : 'border-white/10 text-stone-400'}`}>{t('signIn')}</button>
            <button type="button" aria-pressed={mode === 'register'} onClick={() => { setMode('register'); setMessage(''); }} className={`focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300 min-h-11 rounded-xl border px-3 py-2 text-xs font-semibold ${mode === 'register' ? 'border-rose-500 bg-rose-950/50 text-white' : 'border-white/10 text-stone-400'}`}>{t('register')}</button>
          </div>
          <div className="space-y-3">
            {mode === 'register' && <>
              <label className="block text-xs text-stone-300">{t('profileName')}<input name="registration-display-name" value={displayName} onChange={e => setDisplayName(e.target.value)} minLength={2} maxLength={80} autoComplete="name" className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300" /></label>
              <label className="block text-xs text-stone-300">{t('birthDate')}<input name="registration-birth-date" type="date" value={birthDate} onChange={e => setBirthDate(e.target.value)} max={new Date().toISOString().slice(0, 10)} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300" /></label>
              <label className="block text-xs text-stone-300">{t('gender')}<select name="registration-gender" value={gender} onChange={e => setGender(e.target.value as 'female' | 'male')} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"><option value="female">{t('female')}</option><option value="male">{t('male')}</option></select></label>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="block text-xs text-stone-300">{t('countryLabel')}<input name="registration-country" value={country} onChange={e => setCountry(e.target.value)} maxLength={100} autoComplete="country-name" className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300" /></label>
                <label className="block text-xs text-stone-300">{t('cityLabel')}<input name="registration-city" value={city} onChange={e => setCity(e.target.value)} maxLength={120} autoComplete="address-level2" className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300" /></label>
              </div>
              <label className="block text-xs text-stone-300">{t('relationshipIntentLabel')}<select name="registration-relationship-intent" value={relationshipIntent} onChange={e => setRelationshipIntent(e.target.value as typeof relationshipIntent)} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"><option value="marriage_family">{t('marriageFamilyOption')}</option><option value="family_without_marriage">{t('familyWithoutMarriageOption')}</option><option value="serious_relationship">{t('seriousRelationshipOption')}</option></select></label>
              <label className="block text-xs text-stone-300">{t('familyFormatLabel')}<select name="registration-family-format" value={familyFormat} onChange={e => setFamilyFormat(e.target.value as typeof familyFormat)} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"><option value="open_to_both">{t('openToMarriageAndLiving')}</option><option value="marriage">{t('officialMarriageOnly')}</option><option value="cohabitation">{t('livingTogetherOnly')}</option></select></label>
              <fieldset className="rounded-xl border border-white/10 bg-stone-950 p-3">
                <legend className="px-1 text-xs font-semibold text-white">{t('hasChildrenQuestion')} {t('authChildrenRequired')}</legend>
                <p className="mb-2 text-[10px] leading-relaxed text-stone-400">{t('authChildrenHonestyHelp')}</p>
                <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
                  <button type="button" aria-pressed={hasChildren === true} onClick={() => {setHasChildren(true);setChildrenLivingArrangement('prefer_to_discuss');}} className={`focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300 min-h-11 rounded-lg border p-2 text-xs ${hasChildren === true ? 'border-rose-500 bg-rose-950 text-white' : 'border-white/10 text-stone-300'}`}>{t('yesChildren')}</button>
                  <button type="button" aria-pressed={hasChildren === false} onClick={() => {setHasChildren(false);setChildrenLivingArrangement('not_applicable');}} className={`focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300 min-h-11 rounded-lg border p-2 text-xs ${hasChildren === false ? 'border-rose-500 bg-rose-950 text-white' : 'border-white/10 text-stone-300'}`}>{t('noChildrenAnswer')}</button>
                </div>
                {hasChildren === true && <label className="mt-3 block text-xs text-stone-300">{t('authChildrenLivingPrompt')}<select name="registration-children-living-arrangement" value={childrenLivingArrangement} onChange={e => setChildrenLivingArrangement(e.target.value as typeof childrenLivingArrangement)} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"><option value="with_me">{t('authChildrenWithMe')}</option><option value="shared_custody">{t('authChildrenSharedCustody')}</option><option value="with_other_parent">{t('authChildrenWithOtherParent')}</option><option value="prefer_to_discuss">{t('authChildrenPreferDiscuss')}</option></select></label>}
                <label className="mt-3 block text-xs text-stone-300">{t('authChildrenFuturePrompt')}<select name="registration-wants-children" value={wantsChildren} onChange={e => setWantsChildren(e.target.value as typeof wantsChildren)} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"><option value="yes">{t('authYes')}</option><option value="no">{t('authNo')}</option><option value="discuss">{t('authChildrenDiscuss')}</option><option value="unsure">{t('authChildrenUnsure')}</option></select></label>
              </fieldset>
            </>}
            <label className="block text-xs text-stone-300">{t('email')}<input name="account-email" type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="email" className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300" /></label>
            <label className="block text-xs text-stone-300">{t('passwordMin')}<input name="account-password" type="password" value={password} onChange={e => setPassword(e.target.value)} minLength={12} maxLength={128} required autoComplete={mode === 'login' ? 'current-password' : 'new-password'} className="mt-1 w-full rounded-xl border border-white/10 bg-stone-950 p-3 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300" /></label>
            <button type="button" onClick={() => void submit()} disabled={busy || !email.trim() || password.length < 12 || (mode === 'register' && (!displayName.trim() || !birthDate || !country.trim() || !city.trim() || hasChildren === null))} className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300 min-h-11 w-full rounded-xl bg-rose-600 px-4 py-3 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-40">{busy ? t('wait') : mode === 'login' ? t('signIn') : t('createAccount')}</button>
            {mode === 'login' && <div className="grid grid-cols-1 gap-2">
              <button type="button" onClick={() => void requestPasswordReset()} disabled={busy || !email.trim()} className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300 min-h-11 text-start text-xs text-rose-300 underline disabled:opacity-40">{t('resetEmailLink')}</button>
              {canResendVerification && <button type="button" onClick={() => void resendVerification()} disabled={busy || !email.trim()} className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300 min-h-11 text-start text-xs text-amber-300 underline disabled:opacity-40">{t('resendEmailVerification')}</button>}
            </div>}
          </div>
        </>
      )}
      {message && <p role="status" aria-live="polite" aria-atomic="true" className="mt-3 text-xs leading-relaxed text-stone-300">{message}</p>}
      <p className="mt-3 text-[10px] leading-relaxed text-stone-500">{t('authServerNotice')}</p>
    </section>
  );
};
