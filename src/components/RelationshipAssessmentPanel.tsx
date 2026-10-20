import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ASSESSMENT_QUESTIONS, type AssessmentAnswers } from '../utils/relationshipAssessment.ts';
import { getLocalizedAssessmentQuestions } from '../utils/assessmentTranslations.ts';
import { useLocale } from '../i18n/LocaleProvider.tsx';

const emptyAnswers: AssessmentAnswers = {};

export const RelationshipAssessmentPanel: React.FC = () => {
  const { t, locale } = useLocale();
  const questions = useMemo(() => getLocalizedAssessmentQuestions(locale), [locale]);
  const [answers, setAnswers] = useState<AssessmentAnswers>(emptyAnswers);
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving' | 'saved' | 'login' | 'error'>('loading');
  const [note, setNote] = useState('');
  const answersEditedRef = useRef(false);
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
          return null;
        }
        if (response.status === 402) {
          if (!cancelled) {
            setStatus('ready');
            setNote(t('trialExpiredTest'));
          }
          return null;
        }
        if (!response.ok) throw new Error(t('loadSavedAnswersError'));
        return response.json();
      })
      .then(data => {
        if (cancelled) return;
        const savedAnswers = data?.assessment?.answers;
        if (savedAnswers && typeof savedAnswers === 'object' && !Array.isArray(savedAnswers)) {
          // Do not let a slow initial load overwrite edits made while it was in flight.
          if (!answersEditedRef.current) {
            setAnswers(savedAnswers as AssessmentAnswers);
            setStatus('saved');
            setNote(t('loadedSavedAnswers'));
          }
        } else {
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
    answersEditedRef.current = true;
    setStatus('saving');
    setNote('');
    try {
      const response = await fetch('/api/assessment', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers })
      });
      if (response.status === 401) {
        setStatus('login');
        setNote(t('loginToSaveAssessment'));
        return;
      }
      if (response.status === 402) {
        setStatus('error');
        setNote(t('premiumSaveAssessment'));
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
        <span className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-stone-400">{Object.keys(answers).length}/{questions.length}</span>
      </div>
      <p className="mb-4 text-xs leading-relaxed text-stone-400">
        {t('valuesTestDescription')}
      </p>
      <div className="space-y-4">
        {questions.map((question, index) => (
          <fieldset key={question.id} disabled={status === 'saving'} className="rounded-2xl border border-white/5 bg-stone-950/60 p-3 disabled:opacity-70">
            <legend className="px-1 text-[10px] uppercase tracking-wider text-rose-300">{index + 1}. {question.category}</legend>
            <p className="mb-3 text-sm font-medium text-stone-100">{question.prompt}</p>
            <div className="space-y-2">
              {question.options.map(option => (
                <label key={option.value} className={`flex cursor-pointer items-start gap-2 rounded-xl border p-2.5 text-xs transition-colors ${answers[question.id] === option.value ? 'border-rose-500/60 bg-rose-950/40 text-white' : 'border-white/5 text-stone-300 hover:border-white/20'}`}>
                  <input
                    type="radio"
                    name={question.id}
                    value={option.value}
                    checked={answers[question.id] === option.value}
                    onChange={() => {
                      answersEditedRef.current = true;
                      setAnswers(current => ({ ...current, [question.id]: option.value }));
                    }}
                    className="mt-0.5 accent-rose-500"
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
      <div className="mt-4 flex flex-col gap-2">
        <button type="button" onClick={() => void save()} disabled={!complete || status === 'saving'} className="w-full rounded-xl bg-rose-600 px-4 py-3 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-40">
          {status === 'saving' ? t('savingAnswers') : t('saveAndUseTest')}
        </button>
        {note && <p role="status" aria-live="polite" className="text-xs leading-relaxed text-stone-300">{note}</p>}
        {status === 'saved' && <p className="text-[10px] text-emerald-300">{t('savedOnServer')}</p>}
      </div>
    </section>
  );
};
