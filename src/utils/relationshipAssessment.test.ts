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

test('assessment validator rejects non-object and malformed payloads', () => {
  for (const value of [null, undefined, [], 'answers', 42, true]) {
    assert.equal(validateAssessmentAnswers(value), false, `expected rejection for ${String(value)}`);
  }
});

test('assessment validator rejects missing, extra, empty, and unknown answers', () => {
  const firstQuestion = ASSESSMENT_QUESTIONS[0];
  const incomplete = { ...answers };
  delete incomplete[firstQuestion.id];

  assert.equal(validateAssessmentAnswers(incomplete), false);
  assert.equal(validateAssessmentAnswers({ ...answers, unexpectedAnswer: 'yes' }), false);
  assert.equal(validateAssessmentAnswers({ ...answers, [firstQuestion.id]: '' }), false);
  assert.equal(validateAssessmentAnswers({ ...answers, [firstQuestion.id]: 'not-an-option' }), false);
});

test('assessment validator checks every answer against its question options', () => {
  for (const question of ASSESSMENT_QUESTIONS) {
    assert.equal(
      validateAssessmentAnswers({ ...answers, [question.id]: '__invalid_option__' }),
      false,
      `expected invalid option to be rejected for ${question.id}`
    );
  }
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

import { getLocalizedAssessmentQuestions } from './assessmentTranslations.ts';

test('localized compatibility questions preserve IDs and option values', () => {
  const russian = getLocalizedAssessmentQuestions('ru');
  const english = getLocalizedAssessmentQuestions('en');
  assert.equal(english.length, russian.length);
  for (let i = 0; i < russian.length; i += 1) {
    assert.equal(english[i].id, russian[i].id);
    assert.deepEqual(english[i].options.map(option => option.value), russian[i].options.map(option => option.value));
    assert.ok(english[i].prompt.length > 0);
    assert.ok(english[i].options.every(option => option.label.length > 0));
  }
  assert.notEqual(english[0].prompt, russian[0].prompt);
});
