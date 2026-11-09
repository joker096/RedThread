import React, { useEffect, useMemo, useState } from 'react';
import { ASSESSMENT_QUESTIONS, type AssessmentAnswers, validateAssessmentAnswers, validateDealbreakers, buildAssessmentSavePayload } from '../utils/relationshipAssessment.ts';
import { getLocalizedAssessmentQuestions } from '../utils/assessmentTranslations.ts';
import { useLocale } from '../i18n/LocaleProvider.tsx';

const emptyAnswers: AssessmentAnswers = {};

export const RelationshipAssessmentPanel: React.FC = () => {
  const { t, locale } = useLocale();
  const questions = useMemo(() => getLocalizedAssessmentQuestions(locale), [locale]);
  const [answers, setAnswers] = useState<AssessmentAnswers>(emptyAnswers);
  const [dealbreakers, setDealbreakers] = useState<string[]>([]);
  const [dealbreakersReady, setDealbreakersReady] = useState(false);
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving' | 'saved' | 'login' | 'error'>('loading');
  const [note, setNote] = useState('');
  const complete = useMemo(
    () => questions.every(question => Boolean(answers[question.id])),
    [answers, questions]
  );

  useEffect(() => {
    let cancelled = false;
    fetch('/api/assessment', { credentials: 'include' })
      .then(async response => {
        if (response.status === 401) {
          if (!cancelled) setStatus('ready');
          return { unauthenticated: true };
        }
        if (!response.ok) throw new Error(t('loadSavedAnswersError'));
        return response.json();
      })
      .then(data => {
        if (cancelled || (data && typeof data === 'object' && 'unauthenticated' in data)) return;
        const savedAnswers: unknown = data?.assessment?.answers;
        const savedDealbreakers: unknown = data?.assessment?.dealbreakers;
        setDealbreakers(validateDealbreakers(savedDealbreakers) ? savedDealbreakers : []);
        setDealbreakersReady(true);
        if (validateAssessmentAnswers(savedAnswers)) {
          setAnswers(savedAnswers);
          setStatus('saved');
          setNote(t('loadedSavedAnswers'));
        } else {
          // Keep invalid or incomplete saved answers out of the form, but still
          // restore the independently validated non-negotiable preferences.
          setStatus('ready');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus('ready');
          setNote(t('serverProfileUnavailable'));
        }
      });
    return () => { cancelled = true; };
  }, []);

  const save = async () => {
    if (!complete) {
      setNote(t('answerEveryQuestion'));
      return;
    }
    setStatus('saving');
    setNote('');
    try {
      const response = await fetch('/api/assessment', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildAssessmentSavePayload(answers, dealbreakers, dealbreakersReady))
      });
      if (response.status === 401) {
        setStatus('login');
        setNote(t('loginToSaveAssessment'));
        return;
      }
      if (!response.ok) throw new Error(t('saveAnswersError'));
      setStatus('saved');
      setNote(t('answersSaved'));
    } catch {
      setStatus('error');
      setNote(t('saveAnswersError'));
    }
  };

  return (
    <section aria-busy={status === 'loading' || status === 'saving'} className="vow-screen mb-5 rounded-3xl border border-rose-500/20 bg-stone-900/80 p-4 sm:p-5">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.2em] text-rose-300">{t('valuesTestEyebrow')}</p>
          <h3 className="mt-1 text-lg font-bold text-white">{t('compatibilityImportant')}</h3>
        </div>
        <span role="progressbar" aria-label={t('compatibilityImportant')} aria-valuemin={0} aria-valuemax={questions.length} aria-valuenow={questions.filter(question => Boolean(answers[question.id])).length} className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-stone-400">{questions.filter(question => Boolean(answers[question.id])).length}/{questions.length}</span>
      </div>
      <p className="mb-4 text-xs leading-relaxed text-stone-400">
        {t('valuesTestDescription')}
      </p>
      <p className="mb-4 text-xs leading-relaxed text-stone-500">{t('dealbreakerHelp')}</p>
      {status === 'loading' && <p role="status" className="mb-3 text-xs text-stone-400">{t('loading')}</p>}
      <div className="space-y-4">
        {questions.map((question, index) => (
          <fieldset key={question.id} disabled={status === 'saving' || status === 'loading'} className="rounded-2xl border border-white/5 bg-stone-950/60 p-3 disabled:opacity-70">
            <legend className="max-w-full px-1 text-[10px] uppercase tracking-wider text-rose-300">
              <span className="block">{index + 1}. {question.category}</span>
              <span className="mt-1 block text-sm font-medium normal-case tracking-normal text-stone-100">{question.prompt}</span>
            </legend>
            <div className="space-y-2">
              {question.options.map(option => (
                <label key={option.value} className={`flex min-h-11 cursor-pointer items-start gap-2 rounded-xl border p-2.5 text-xs transition-colors ${answers[question.id] === option.value ? 'border-rose-500/60 bg-rose-950/40 text-white' : 'border-white/5 text-stone-300 hover:border-white/20'}`}>
                  <input
                    type="radio"
                    name={question.id}
                    value={option.value}
                    checked={answers[question.id] === option.value}
                    onChange={() => {
                      setAnswers(current => ({ ...current, [question.id]: option.value }));
                    }}
                    className="mt-0.5 min-h-5 min-w-5 accent-rose-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
            <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-amber-400/20 bg-amber-950/10 px-3 py-2 text-xs text-amber-100">
              <input type="checkbox" checked={dealbreakers.includes(question.id)} disabled={!dealbreakersReady || status === 'saving'} onChange={event => {
                setDealbreakers(current => event.target.checked
                  ? [...current, question.id]
                  : current.filter(id => id !== question.id));
              }} className="min-h-5 min-w-5 accent-amber-400" />
              <span>{t('markAsDealbreaker')}</span>
            </label>
          </fieldset>
        ))}
      </div>
      <div className="mt-4 flex flex-col gap-2">
        <button type="button" onClick={() => void save()} disabled={!complete || status === 'saving' || status === 'loading'} className="w-full min-h-11 rounded-xl bg-rose-600 px-4 py-3 text-sm font-bold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300 disabled:cursor-not-allowed disabled:opacity-40">
          {status === 'saving' ? t('savingAnswers') : t('saveAndUseTest')}
        </button>
        {note && <p role="status" aria-live="polite" aria-atomic="true" className="text-xs leading-relaxed text-stone-300">{note}</p>}
        {status === 'saved' && <p className="text-[10px] text-emerald-300">{t('savedOnServer')}</p>}
      </div>
    </section>
  );
};
