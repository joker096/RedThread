import test from 'node:test';
import assert from 'node:assert/strict';
import { ASSESSMENT_OPTIONS, assessmentCompatibility, financialAlignment, isValidAssessment } from './relationshipAssessment.js';

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


test('compatibility explanations group alignment and differences into four useful dimensions', async () => {
  const { explainAssessmentCompatibility } = await import('./relationshipAssessment.js');
  const other = { ...answers, children: 'do_not_want', financialModel: 'provider_full', conflictStyle: 'avoid', relocation: 'international' };
  const result = explainAssessmentCompatibility(answers, other);
  assert.equal(result.version, 2);
  assert.equal(result.score, assessmentCompatibility(answers, other).score);
  assert.deepEqual(result.dimensions.map(item => item.key), ['family', 'budget', 'conflict', 'lifestyle']);
  assert.deepEqual(result.dimensions.find(item => item.key === 'family').discussionPoints, ['children']);
  assert.deepEqual(result.dimensions.find(item => item.key === 'budget').discussionPoints, ['financialModel']);
  assert.deepEqual(result.dimensions.find(item => item.key === 'conflict').discussionPoints, ['conflictStyle']);
  assert.deepEqual(result.dimensions.find(item => item.key === 'lifestyle').discussionPoints, ['relocation']);
  assert.deepEqual(result.dealbreakers, []);
  assert.equal(result.dealbreakersConfigured, false);
});

test('compatibility explanations reject incomplete or malformed answer sets', async () => {
  const { explainAssessmentCompatibility } = await import('./relationshipAssessment.js');
  assert.equal(explainAssessmentCompatibility(answers, { children: 'want_soon' }), null);
  assert.equal(explainAssessmentCompatibility(null, answers), null);
});
