export const ASSESSMENT_VERSION = 1;

export const ASSESSMENT_OPTIONS = {
  relationshipGoal: ['marriage_soon', 'marriage_later', 'serious_no_rush'],
  children: ['want_soon', 'want_later', 'unsure', 'do_not_want'],
  financialModel: ['shared_equal', 'proportional', 'provider_primary', 'provider_full', 'independent'],
  lifestyleExpectation: ['modest', 'balanced', 'premium'],
  gifts: ['low', 'medium', 'high'],
  household: ['equal', 'strengths', 'traditional'],
  fidelity: ['strict', 'discussed'],
  conflictStyle: ['talk_soon', 'time_first', 'avoid'],
  honesty: ['essential', 'gradual']
};

export function isValidAssessment(answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return false;
  const keys = Object.keys(answers);
  const expected = Object.keys(ASSESSMENT_OPTIONS);
  return keys.length === expected.length && expected.every(key => typeof answers[key] === 'string' && ASSESSMENT_OPTIONS[key].includes(answers[key]));
}

export function assessmentCompatibility(first, second) {
  const weights = { relationshipGoal: 2, children: 2, financialModel: 3, lifestyleExpectation: 1, gifts: 1, household: 1, fidelity: 2, conflictStyle: 1, honesty: 2 };
  const keys = Object.keys(ASSESSMENT_OPTIONS);
  const aligned = keys.filter(key => first[key] === second[key]);
  const possibleWeight = keys.reduce((sum, key) => sum + weights[key], 0);
  const earnedWeight = aligned.reduce((sum, key) => sum + weights[key], 0);
  return { score: Math.round(earnedWeight / possibleWeight * 100), alignedCount: aligned.length, total: keys.length };
}

export function financialAlignment(first, second) {
  const keys = ['financialModel', 'lifestyleExpectation', 'gifts'];
  const aligned = keys.filter(key => first[key] === second[key]);
  return { score: Math.round(aligned.length / keys.length * 100), alignedCount: aligned.length, total: keys.length };
}
