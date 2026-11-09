import test from 'node:test';
import assert from 'node:assert/strict';
import { ASSESSMENT_OPTIONS, assessmentCompatibility, assessmentCompatibilityBreakdown, assessmentVersionGaps, explainAssessmentCompatibility, financialAlignment, isValidAssessment, isValidDealbreakers } from './relationshipAssessment.js';

const answers = Object.fromEntries(Object.entries(ASSESSMENT_OPTIONS).map(([key, options]) => [key, options[0]]));

test('server rejects missing, extra and invalid assessment answers', () => {
  assert.equal(isValidAssessment(answers), true);
  assert.equal(isValidAssessment({ ...answers, extra: 'nope' }), false);
  assert.equal(isValidAssessment({ ...answers, gifts: 'only_expensive' }), false);
  assert.equal(isValidAssessment(null), false);
});

test('server compatibility is deterministic and transparent', () => {
  assert.equal(assessmentCompatibility(answers, answers).score, 100);
  assert.equal(assessmentCompatibility(answers, { ...answers, children: 'do_not_want' }).score, 92);
});

test('financial alignment compares declared preferences without labeling a person', () => {
  const result = financialAlignment(answers, { ...answers, financialModel: 'provider_full', gifts: 'high' });
  assert.equal(result.score, 33);
  assert.equal(result.alignedCount, 1);
});

test('validates explicit non-negotiable fields without duplicates or unknown keys', () => {
  assert.equal(isValidDealbreakers([]), true);
  assert.equal(isValidDealbreakers(['children', 'financialModel']), true);
  assert.equal(isValidDealbreakers(['children', 'children']), false);
  assert.equal(isValidDealbreakers(['unknown']), false);
  assert.equal(isValidDealbreakers('children'), false);
  assert.equal(isValidDealbreakers(Array(16).fill('children')), false);
});

test('returns four transparent compatibility dimensions without exposing answer values', () => {
  const second = { ...answers, children: 'do_not_want', financialModel: 'provider_full', conflictStyle: 'avoid', relocation: 'international' };
  const result = assessmentCompatibilityBreakdown(answers, second, ['children', 'financialModel'], ['conflictStyle']);
  assert.equal(result.dimensions.length, 4);
  assert.deepEqual(result.dimensions.map(item => item.id), ['family', 'budget', 'conflict', 'lifestyle']);
  assert.equal(result.dimensions.find(item => item.id === 'family').score, 67);
  assert.equal(result.dimensions.find(item => item.id === 'budget').score, 57);
  assert.deepEqual(result.yourDealbreakerConflicts, ['children', 'financialModel']);
  assert.deepEqual(result.partnerDealbreakerConflicts, ['conflictStyle']);
  assert.equal(JSON.stringify(result).includes('do_not_want'), false);
  assert.equal(JSON.stringify(result).includes('provider_full'), false);
});

test('compatibility breakdown rejects invalid persisted answers or dealbreakers', () => {
  assert.throws(() => assessmentCompatibilityBreakdown(answers, { ...answers, invalid: 'x' }), /invalid_assessment_compatibility_input/);
  assert.throws(() => assessmentCompatibilityBreakdown(answers, answers, ['not-a-field']), /invalid_assessment_compatibility_input/);
});

test('discovery compatibility explains four weighted dimensions without exposing answers or deal-breakers', () => {
  const other = { ...answers, children: 'do_not_want', financialModel: 'provider_full', conflictStyle: 'avoid', relocation: 'international' };
  const result = explainAssessmentCompatibility(answers, other);
  assert.equal(result.version, 2);
  assert.equal(result.score, assessmentCompatibility(answers, other).score);
  assert.deepEqual(result.dimensions.map(item => item.key), ['family', 'budget', 'conflict', 'lifestyle']);
  assert.deepEqual(result.dimensions.find(item => item.key === 'family').discussionPoints, ['children']);
  assert.deepEqual(result.dimensions.find(item => item.key === 'budget').discussionPoints, ['financialModel']);
  assert.deepEqual(result.dimensions.find(item => item.key === 'conflict').discussionPoints, ['conflictStyle']);
  assert.deepEqual(result.dimensions.find(item => item.key === 'lifestyle').discussionPoints, ['relocation']);
  assert.equal(result.dealbreakersHiddenUntilMatch, true);
  assert.equal(JSON.stringify(result).includes('marriage_soon'), false);
  assert.equal(JSON.stringify(result).includes('do_not_want'), false);
  assert.equal(Object.hasOwn(result, 'dealbreakers'), false);
});

test('discovery compatibility refuses incomplete assessment answers', () => {
  assert.equal(explainAssessmentCompatibility(answers, { children: 'want_soon' }), null);
  assert.equal(explainAssessmentCompatibility(null, answers), null);
});

test('compatibility requires both participants to use the current assessment version', () => {
  assert.deepEqual(assessmentVersionGaps(2, 2), []);
  assert.deepEqual(assessmentVersionGaps(1, 2), ['self']);
  assert.deepEqual(assessmentVersionGaps(2, 1), ['partner']);
  assert.deepEqual(assessmentVersionGaps(undefined, undefined), ['self', 'partner']);
});

test('detailed dimension scores use the same declared field weights as discovery', () => {
  const other = { ...answers, children: 'do_not_want', financialModel: 'provider_full' };
  const detailed = assessmentCompatibilityBreakdown(answers, other);
  const discovery = explainAssessmentCompatibility(answers, other);
  for (const dimension of detailed.dimensions) {
    const matching = discovery.dimensions.find(item => item.key === dimension.id);
    assert.equal(dimension.score, matching.score);
  }
});
