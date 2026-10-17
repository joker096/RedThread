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

test('every advertised language has a truthful, internally consistent coverage report', () => {
  const locales = LANGUAGE_OPTIONS.filter(language => language.code !== 'auto');
  assert.ok(locales.length >= 40, 'The international language selector should remain comprehensive');

  for (const language of locales) {
    const coverage = getTranslationCoverage(language.code);
    assert.equal(coverage.locale, language.code);
    assert.ok(coverage.total > 0, `${language.code} must report the English message catalog size`);
    assert.equal(coverage.translated + coverage.missing.length, coverage.total,
      `${language.code} translated and missing counts must account for every message`);
    assert.equal(coverage.percentage, Math.round((coverage.translated / coverage.total) * 100),
      `${language.code} percentage must match its actual translated key count`);
    assert.ok(coverage.percentage >= 0 && coverage.percentage <= 100);
    assert.equal(new Set(coverage.missing).size, coverage.missing.length,
      `${language.code} must not report duplicate missing keys`);
  }
});

test('unsupported advertised locales fall back honestly rather than claiming complete translation', () => {
  for (const language of LANGUAGE_OPTIONS.filter(item => !['auto', 'en', 'ru', 'es', 'fr', 'de', 'pt', 'it', 'tr', 'ar', 'zh', 'hi'].includes(item.code))) {
    const coverage = getTranslationCoverage(language.code);
    if (coverage.translated === 0) {
      assert.equal(coverage.percentage, 0);
      assert.equal(coverage.missing.length, coverage.total);
    }
  }
});

test('Georgian translations cover the core discovery and safety interface without claiming full localization', () => {
  const georgian = getTranslationCoverage('ka');
  assert.ok(georgian.translated > 0, 'Georgian should provide real translated messages');
  assert.ok(georgian.percentage < 100, 'Partial Georgian coverage must remain clearly partial');
  for (const key of ['language', 'discovery', 'safety', 'like', 'report', 'block', 'search', 'relationshipGoal']) {
    assert.ok(!georgian.missing.includes(key), `Georgian core key "${key}" should be translated`);
  }
});
