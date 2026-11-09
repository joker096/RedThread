import test from 'node:test';
import assert from 'node:assert/strict';
import { ASSESSMENT_OPTIONS } from './relationshipAssessment.js';
import { buildAssessmentCompatibilityExplanation } from './assessmentCompatibilityExplanation.js';

const answers = Object.fromEntries(
  Object.entries(ASSESSMENT_OPTIONS).map(([key, options]) => [key, options[0]])
);

test('compatibility explanation returns a privacy-minimized dimension matrix', () => {
  const result = buildAssessmentCompatibilityExplanation(answers, answers);
  assert.equal(result.score, 100);
  assert.equal(result.dimensions.length, Object.keys(ASSESSMENT_OPTIONS).length);
  assert.ok(result.dimensions.every(item => ['aligned', 'different'].includes(item.status)));
  assert.equal(Object.hasOwn(result, 'firstAnswers'), false);
  assert.deepEqual(result.dealbreakers, []);
  assert.equal(result.dealbreakersConfigured, false);
});

test('high-impact differences become conversation topics, not automatic dealbreakers', () => {
  const other = { ...answers, children: 'do_not_want', financialModel: 'provider_full' };
  const result = buildAssessmentCompatibilityExplanation(answers, other);
  assert.deepEqual(result.conversationTopics.sort(), ['children', 'financialModel']);
  assert.deepEqual(result.dealbreakers, []);
});

test('invalid or incomplete assessments are never explained', () => {
  assert.equal(buildAssessmentCompatibilityExplanation(answers, { children: 'want_soon' }), null);
  assert.equal(buildAssessmentCompatibilityExplanation(null, answers), null);
});
