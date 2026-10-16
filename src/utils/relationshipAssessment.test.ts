import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSESSMENT_QUESTIONS,
  calculateAssessmentCompatibility,
  getFinancialAlignment,
  validateAssessmentAnswers
} from './relationshipAssessment.ts';

const answers = Object.fromEntries(
  ASSESSMENT_QUESTIONS.map(question => [question.id, question.options[0].value])
);

test('assessment requires a valid answer to every declared question', () => {
  assert.equal(validateAssessmentAnswers(answers), true);
  assert.equal(validateAssessmentAnswers({ ...answers, financialModel: 'rich_only' }), false);
  assert.equal(validateAssessmentAnswers({}), false);
});

test('identical answers produce full preference alignment', () => {
  const result = calculateAssessmentCompatibility(answers, { ...answers });
  assert.equal(result.score, 100);
  assert.equal(result.differences.length, 0);
});

test('financial alignment measures stated preference differences, not character', () => {
  const other = { ...answers, financialModel: 'provider_full', gifts: 'high' };
  const result = getFinancialAlignment(answers, other);
  assert.equal(result.score, 33);
  assert.deepEqual(result.differences.sort(), ['financialModel', 'gifts']);
});
