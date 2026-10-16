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
