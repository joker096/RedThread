import { ASSESSMENT_OPTIONS, assessmentCompatibility, isValidAssessment } from './relationshipAssessment.js';

const IMPORTANT_DIMENSIONS = new Set([
  'relationshipGoal',
  'children',
  'financialModel',
  'fidelity',
  'trustRepair',
  'conflictSafety',
  'debtTransparency'
]);

/**
 * Returns a privacy-minimized explanation of two participants' declared
 * preferences. It never exposes either participant's raw assessment answers.
 * A difference is not automatically a dealbreaker: Vow has no user-authored
 * dealbreaker preferences in the current assessment schema.
 */
export function buildAssessmentCompatibilityExplanation(first, second) {
  if (!isValidAssessment(first) || !isValidAssessment(second)) {
    return null;
  }

  const score = assessmentCompatibility(first, second);
  const dimensions = Object.keys(ASSESSMENT_OPTIONS).map(key => ({
    key,
    status: first[key] === second[key] ? 'aligned' : 'different',
    importance: IMPORTANT_DIMENSIONS.has(key) ? 'high' : 'standard'
  }));

  return {
    version: 1,
    score: score.score,
    alignedCount: score.alignedCount,
    total: score.total,
    dimensions,
    conversationTopics: dimensions
      .filter(item => item.status === 'different' && item.importance === 'high')
      .map(item => item.key),
    dealbreakers: [],
    dealbreakersConfigured: false
  };
}
