export const ASSESSMENT_VERSION = 2;

export const ASSESSMENT_OPTIONS = {
  relationshipGoal: ['marriage_soon', 'marriage_later', 'serious_no_rush'],
  children: ['want_soon', 'want_later', 'unsure', 'do_not_want'],
  financialModel: ['shared_equal', 'proportional', 'provider_primary', 'provider_full', 'independent'],
  lifestyleExpectation: ['modest', 'balanced', 'premium'],
  gifts: ['low', 'medium', 'high'],
  household: ['equal', 'strengths', 'traditional'],
  fidelity: ['strict', 'discussed'],
  conflictStyle: ['talk_soon', 'time_first', 'avoid'],
  honesty: ['essential', 'gradual'],
  trustRepair: ['accountability_actions', 'time_transparency', 'not_reconcile'],
  conflictSafety: ['no_insults_control', 'pause_then_talk', 'learning_boundaries'],
  debtTransparency: ['open_before_commitment', 'gradual_disclosure', 'keep_separate'],
  substanceLifestyle: ['no_smoking_no_drugs', 'occasional_social', 'flexible'],
  relocation: ['stay_local', 'within_country', 'international', 'depends_on_plan'],
  caregiving: ['shared_care', 'family_primary', 'professional_support', 'case_by_case']
};

export function isValidAssessment(answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return false;
  const keys = Object.keys(answers);
  const expected = Object.keys(ASSESSMENT_OPTIONS);
  return keys.length === expected.length && expected.every(key => typeof answers[key] === 'string' && ASSESSMENT_OPTIONS[key].includes(answers[key]));
}

export function assessmentCompatibility(first, second) {
  const weights = { relationshipGoal: 2, children: 2, financialModel: 3, lifestyleExpectation: 1, gifts: 1, household: 1, fidelity: 2, conflictStyle: 1, honesty: 2, trustRepair: 2, conflictSafety: 3, debtTransparency: 2, substanceLifestyle: 1, relocation: 1, caregiving: 1 };
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
