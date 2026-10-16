import test from 'node:test';
import assert from 'node:assert/strict';
import { getTranslationCoverage, LANGUAGE_OPTIONS } from './LocaleProvider.tsx';

test('English and Russian catalogs cover every defined message key', () => {
  assert.equal(getTranslationCoverage('en').percentage, 100);
  assert.equal(getTranslationCoverage('en').missing.length, 0);
  assert.equal(getTranslationCoverage('ru').percentage, 100);
  assert.equal(getTranslationCoverage('ru').missing.length, 0);
});

test('partial and fallback locales are reported honestly', () => {
  const spanish = getTranslationCoverage('es');
  assert.ok(spanish.percentage > 0 && spanish.percentage < 100);
  assert.ok(spanish.missing.length > 0);

  const swahili = getTranslationCoverage('sw');
  assert.equal(swahili.translated, 0);
  assert.equal(swahili.percentage, 0);
  assert.equal(swahili.missing.length, swahili.total);
  assert.ok(LANGUAGE_OPTIONS.some(language => language.code === 'sw'));
});


test('language selector has unique locale codes and explicit auto, English, and Russian options', () => {
  const codes = LANGUAGE_OPTIONS.map(language => language.code);
  assert.equal(new Set(codes).size, codes.length, 'Locale codes must be unique');
  assert.ok(codes.includes('auto'));
  assert.ok(codes.includes('en'));
  assert.ok(codes.includes('ru'));
  assert.ok(LANGUAGE_OPTIONS.every(language => language.nativeName.trim().length > 0));
});
