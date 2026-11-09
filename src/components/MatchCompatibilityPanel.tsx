import React, { useEffect, useMemo, useState } from 'react';
import { useLocale } from '../i18n/LocaleProvider.tsx';
import { getLocalizedAssessmentQuestions } from '../utils/assessmentTranslations.ts';

type DimensionId = 'family' | 'budget' | 'conflict' | 'lifestyle';
type CompatibilityPayload = {
  overallScore: number;
  dimensions: Array<{ id: DimensionId; score: number; alignedCount: number; total: number; differences: string[] }>;
  yourDealbreakerConflicts: string[];
  partnerDealbreakerConflicts: string[];
};

const QUESTION_IDS = new Set([
  'relationshipGoal', 'children', 'financialModel', 'lifestyleExpectation', 'gifts',
  'household', 'fidelity', 'conflictStyle', 'honesty', 'trustRepair', 'conflictSafety',
  'debtTransparency', 'substanceLifestyle', 'relocation', 'caregiving'
]);
const DIMENSION_IDS = new Set<DimensionId>(['family', 'budget', 'conflict', 'lifestyle']);

export function normalizeCompatibilityPayload(value: unknown): CompatibilityPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  const dimensions = payload.dimensions;
  const validFieldList = (fields: unknown) => Array.isArray(fields) &&
    fields.length <= QUESTION_IDS.size &&
    fields.every((field, index) => typeof field === 'string' && QUESTION_IDS.has(field) && fields.indexOf(field) === index);
  if (typeof payload.overallScore !== 'number' || !Number.isInteger(payload.overallScore) ||
      payload.overallScore < 0 || payload.overallScore > 100 ||
      !Array.isArray(dimensions) || dimensions.length !== 4 ||
      !validFieldList(payload.yourDealbreakerConflicts) ||
      !validFieldList(payload.partnerDealbreakerConflicts)) return null;
  const normalized = dimensions.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (typeof item.id !== 'string' || !DIMENSION_IDS.has(item.id as DimensionId) ||
        typeof item.score !== 'number' || !Number.isInteger(item.score) || item.score < 0 || item.score > 100 ||
        typeof item.alignedCount !== 'number' || !Number.isInteger(item.alignedCount) || item.alignedCount < 0 ||
        typeof item.total !== 'number' || !Number.isInteger(item.total) || item.total < 1 ||
        item.alignedCount > item.total || !validFieldList(item.differences)) return null;
    return { id: item.id as DimensionId, score: item.score, alignedCount: item.alignedCount, total: item.total, differences: item.differences as string[] };
  });
  if (normalized.some(item => item === null) || new Set(normalized.map(item => item?.id)).size !== 4) return null;
  return {
    overallScore: payload.overallScore,
    dimensions: normalized as CompatibilityPayload['dimensions'],
    yourDealbreakerConflicts: payload.yourDealbreakerConflicts as string[],
    partnerDealbreakerConflicts: payload.partnerDealbreakerConflicts as string[]
  };
}

type Props = { matchId: string; onClose: () => void };

export const MatchCompatibilityPanel: React.FC<Props> = ({ matchId, onClose }) => {
  const { t, locale } = useLocale();
  const questions = useMemo(() => getLocalizedAssessmentQuestions(locale), [locale]);
  const [payload, setPayload] = useState<CompatibilityPayload | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable' | 'error'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setPayload(null);
    setError('');
    fetch(`/api/matches/${encodeURIComponent(matchId)}/compatibility`, { credentials: 'include', cache: 'no-store' })
      .then(async response => {
        const data = await response.json().catch(() => null);
        if (cancelled) return;
        if (response.status === 409 && data?.error === 'assessment_incomplete') {
          setStatus('unavailable');
          return;
        }
        if (!response.ok) throw new Error(response.status === 404 ? t('loadMessagesError') : t('serverProfileUnavailable'));
        const normalized = normalizeCompatibilityPayload(data);
        if (!normalized) throw new Error(t('serverProfileUnavailable'));
        setPayload(normalized);
        setStatus('ready');
      })
      .catch(reason => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : t('serverProfileUnavailable'));
          setStatus('error');
        }
      });
    return () => { cancelled = true; };
  }, [matchId, t]);

  const dimensionLabel = (id: DimensionId) => ({
    family: t('compatFamily'),
    budget: t('compatBudget'),
    conflict: t('compatConflict'),
    lifestyle: t('compatLifestyle')
  })[id];
  const fieldLabel = (id: string) => questions.find(question => question.id === id)?.category || id;
  const conflicts = (fields: string[]) => [...new Set(fields.map(fieldLabel))];

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/75 p-2 sm:items-center sm:p-5" role="presentation" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="vow-compatibility-title" aria-describedby="vow-compatibility-description" className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-3xl border border-rose-400/20 bg-[#111114] p-5 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p id="vow-compatibility-description" className="text-[10px] font-bold uppercase tracking-[0.2em] text-rose-300">{t('compatibilityDetails')}</p>
            <h3 id="vow-compatibility-title" className="mt-1 text-xl font-bold text-white">{t('compatibilityScore')}</h3>
          </div>
          <button type="button" onClick={onClose} aria-label={t('close')} aria-keyshortcuts="Escape" className="min-h-11 min-w-11 rounded-xl border border-white/10 text-xl text-stone-300">×</button>
        </div>
        {status === 'loading' && <p role="status" className="py-8 text-center text-sm text-stone-300">{t('loading')}</p>}
        {status === 'unavailable' && <p role="status" className="rounded-2xl border border-white/10 bg-stone-950 p-4 text-sm text-stone-300">{t('compatibilityUnavailable')}</p>}
        {status === 'error' && <p role="alert" className="rounded-2xl border border-rose-500/20 bg-rose-950/20 p-4 text-sm text-rose-200">{error}</p>}
        {status === 'ready' && payload && <>
          <div className="mb-4 rounded-2xl border border-rose-400/20 bg-rose-950/20 p-4">
            <div className="flex items-end justify-between gap-3">
              <span className="text-sm text-stone-200">{t('compatibilityScore')}</span>
              <strong className="text-3xl tabular-nums text-rose-200">{payload.overallScore}%</strong>
            </div>
            <p className="mt-1 text-[11px] text-stone-400">{t('valuesTestDescription')}</p>
          </div>
          <div className="space-y-3">
            {payload.dimensions.map(dimension => <article key={dimension.id} className="rounded-2xl border border-white/10 bg-stone-950/70 p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <h4 className="text-sm font-semibold text-white">{dimensionLabel(dimension.id)}</h4>
                <span className="text-sm font-bold tabular-nums text-rose-200">{dimension.score}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-label={dimensionLabel(dimension.id)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={dimension.score}>
                <div className="h-full rounded-full bg-rose-500" style={{ width: `${dimension.score}%` }} />
              </div>
              <p className="mt-2 text-[11px] text-stone-400">{dimension.alignedCount}/{dimension.total}</p>
              {dimension.differences.length > 0 && <p className="mt-1 text-xs text-stone-300">{t('differences')}: {conflicts(dimension.differences).join(', ')}</p>}
            </article>)}
          </div>
          <div className="mt-4 space-y-3">
            <section className="rounded-2xl border border-amber-400/20 bg-amber-950/10 p-3">
              <h4 className="text-xs font-semibold text-amber-100">{t('yourDealbreakerConflicts')}</h4>
              <p className="mt-1 text-xs text-stone-300">{payload.yourDealbreakerConflicts.length ? conflicts(payload.yourDealbreakerConflicts).join(', ') : t('noDealbreakerConflicts')}</p>
            </section>
            <section className="rounded-2xl border border-amber-400/20 bg-amber-950/10 p-3">
              <h4 className="text-xs font-semibold text-amber-100">{t('partnerDealbreakerConflicts')}</h4>
              <p className="mt-1 text-xs text-stone-300">{payload.partnerDealbreakerConflicts.length ? conflicts(payload.partnerDealbreakerConflicts).join(', ') : t('noDealbreakerConflicts')}</p>
            </section>
          </div>
          <p className="mt-3 text-[10px] leading-relaxed text-stone-500">{t('dealbreakerHelp')}</p>
        </>}
      </section>
    </div>
  );
};
