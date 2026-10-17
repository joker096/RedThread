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
  for (const language of LANGUAGE_OPTIONS.filter(item => !['auto', 'en', 'ru', 'es', 'fr', 'de', 'pt', 'it', 'tr', 'ar', 'zh', 'hi', 'ka', 'vi'].includes(item.code))) {
    const coverage = getTranslationCoverage(language.code);
    if (coverage.translated === 0) {
      assert.equal(coverage.percentage, 0);
      assert.equal(coverage.missing.length, coverage.total);
    }
  }
});

test('Spanish catalog covers core discovery, safety, account and messaging UI', () => {
  const spanish = getTranslationCoverage('es');
  assert.ok(spanish.translated >= 100, 'Spanish should translate a substantial core set of UI messages');
  assert.ok(spanish.percentage > 0 && spanish.percentage < 100,
    'Spanish must be reported as partial until the complete catalog is translated');
  for (const key of [
    'language', 'discovery', 'safety', 'like', 'pass', 'report', 'block',
    'search', 'relationshipGoal', 'accountTitle', 'signIn', 'createAccount',
    'email', 'password', 'chats', 'notificationCenter', 'authInvalidEmail',
    'authDeleteConfirm', 'partialTranslationHelp'
  ] as const) {
    assert.ok(!spanish.missing.includes(key), `Spanish core key "${key}" should be translated`);
  }
});

test('French catalog covers core discovery, safety, account and messaging UI', () => {
  const french = getTranslationCoverage('fr');
  assert.ok(french.translated >= 100, 'French should translate a substantial core set of UI messages');
  assert.ok(french.percentage > 0 && french.percentage < 100, 'French must remain marked partial until complete');
  for (const key of ['language','discovery','safety','like','pass','report','block','search','relationshipGoal','accountTitle','signIn','createAccount','email','password','chats','notificationCenter','authInvalidEmail','authDeleteConfirm','partialTranslationHelp'] as const) {
    assert.ok(!french.missing.includes(key), `French core key "${key}" should be translated`);
  }
});

test('German catalog covers core discovery, safety, account and messaging UI', () => {
  const german = getTranslationCoverage('de');
  assert.ok(german.translated >= 100, 'German should translate a substantial core set of UI messages');
  assert.ok(german.percentage > 0 && german.percentage < 100, 'German must remain partial until complete');
  for (const key of [
    'language', 'discovery', 'safety', 'like', 'pass', 'report', 'block', 'search',
    'relationshipGoal', 'accountTitle', 'signIn', 'createAccount', 'email', 'password',
    'chats', 'notificationCenter', 'authInvalidEmail', 'authDeleteConfirm', 'partialTranslationHelp'
  ] as const) {
    assert.ok(!german.missing.includes(key), `German core key "${key}" should be translated`);
  }
});

test('Portuguese catalog covers core discovery, safety, account and messaging UI', () => {
  const portuguese = getTranslationCoverage('pt');
  assert.ok(portuguese.translated >= 100, 'Portuguese should translate a substantial core set of UI messages');
  assert.ok(portuguese.percentage > 0 && portuguese.percentage < 100, 'Portuguese must remain partial until complete');
  for (const key of [
    'language', 'discovery', 'safety', 'like', 'pass', 'report', 'block', 'search',
    'relationshipGoal', 'accountTitle', 'signIn', 'createAccount', 'email', 'password',
    'chats', 'notificationCenter', 'authInvalidEmail', 'authDeleteConfirm', 'partialTranslationHelp'
  ] as const) {
    assert.ok(!portuguese.missing.includes(key), `Portuguese core key "${key}" should be translated`);
  }
});

test('Georgian translations cover the core discovery and safety interface without claiming full localization', () => {
  const georgian = getTranslationCoverage('ka');
  assert.ok(georgian.translated > 0, 'Georgian should provide real translated messages');
  assert.ok(georgian.percentage < 100, 'Partial Georgian coverage must remain clearly partial');
  for (const key of ['language', 'discovery', 'safety', 'like', 'report', 'block', 'search', 'relationshipGoal'] as const) {
    assert.ok(!georgian.missing.includes(key), `Georgian core key "${key}" should be translated`);
  }
});
test('account access copy stays in the locale catalog instead of hardcoded Cyrillic text', async () => {
  const { readFile } = await import('node:fs/promises');
  const component = await readFile(new URL('../components/AccountAccessPanel.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(component, /[А-Яа-яЁё]/,
    'AccountAccessPanel copy should use translation keys so locale changes apply consistently');
});


test('Arabic catalog covers core discovery, safety, account and messaging UI', () => {
  const arabic = getTranslationCoverage('ar');
  assert.ok(arabic.translated >= 100, 'Arabic should translate a substantial core set of UI messages');
  assert.ok(arabic.percentage > 0 && arabic.percentage < 100,
    'Arabic must remain marked partial until the complete catalog is translated');
  for (const key of [
    'language', 'discovery', 'safety', 'like', 'pass', 'report', 'block',
    'search', 'relationshipGoal', 'accountTitle', 'signIn', 'createAccount',
    'email', 'password', 'chats', 'notificationCenter', 'authInvalidEmail',
    'authDeleteConfirm', 'partialTranslationHelp'
  ] as const) {
    assert.ok(!arabic.missing.includes(key), `Arabic core key "${key}" should be translated`);
  }
});


test('Italian catalog covers core discovery, safety, account and messaging UI', () => {
  const italian = getTranslationCoverage('it');
  assert.ok(italian.translated >= 100, 'Italian should translate a substantial core set of UI messages');
  assert.ok(italian.percentage > 0 && italian.percentage < 100,
    'Italian must remain marked partial until the complete catalog is translated');
  for (const key of [
    'language', 'discovery', 'safety', 'like', 'pass', 'report', 'block',
    'search', 'relationshipGoal', 'accountTitle', 'signIn', 'createAccount',
    'email', 'password', 'chats', 'notificationCenter', 'authInvalidEmail',
    'authDeleteConfirm', 'partialTranslationHelp'
  ] as const) {
    assert.ok(!italian.missing.includes(key), `Italian core key "${key}" should be translated`);
  }
});


test('Japanese catalog covers core discovery, safety, account and messaging UI', () => {
  const japanese = getTranslationCoverage('ja');
  assert.ok(japanese.translated >= 100, 'Japanese should translate a substantial core set of UI messages');
  assert.ok(japanese.percentage > 0 && japanese.percentage < 100,
    'Japanese must remain marked partial until the complete catalog is translated');
  for (const key of [
    'language', 'discovery', 'safety', 'like', 'pass', 'report', 'block',
    'search', 'relationshipGoal', 'accountTitle', 'signIn', 'createAccount',
    'email', 'password', 'chats', 'notificationCenter', 'authInvalidEmail',
    'authDeleteConfirm', 'partialTranslationHelp'
  ] as const) {
    assert.ok(!japanese.missing.includes(key), `Japanese core key "${key}" should be translated`);
  }
});


test('Korean catalog covers core discovery, safety, account and messaging UI', () => {
  const korean = getTranslationCoverage('ko');
  assert.ok(korean.translated >= 100, 'Korean should translate a substantial core set of UI messages');
  assert.ok(korean.percentage > 0 && korean.percentage < 100,
    'Korean must remain marked partial until the complete catalog is translated');
  for (const key of [
    'language', 'discovery', 'safety', 'like', 'pass', 'report', 'block',
    'search', 'relationshipGoal', 'accountTitle', 'signIn', 'createAccount',
    'email', 'password', 'chats', 'notificationCenter', 'authInvalidEmail',
    'authDeleteConfirm', 'partialTranslationHelp'
  ] as const) {
    assert.ok(!korean.missing.includes(key), `Korean core key "${key}" should be translated`);
  }
});


test('Chinese catalog covers core discovery, safety, account and messaging UI', () => {
  const chinese = getTranslationCoverage('zh');
  assert.ok(chinese.translated >= 100, 'Chinese should translate a substantial core set of UI messages');
  assert.ok(chinese.percentage > 0 && chinese.percentage < 100,
    'Chinese must remain marked partial until the complete catalog is translated');
  for (const key of [
    'language', 'discovery', 'safety', 'like', 'pass', 'report', 'block',
    'search', 'relationshipGoal', 'accountTitle', 'signIn', 'createAccount',
    'email', 'password', 'chats', 'notificationCenter', 'authInvalidEmail',
    'authDeleteConfirm', 'partialTranslationHelp'
  ] as const) {
    assert.ok(!chinese.missing.includes(key), `Chinese core key "${key}" should be translated`);
  }
});


test('Hindi catalog covers core discovery, safety, account and messaging UI', () => {
  const hindi = getTranslationCoverage('hi');
  assert.ok(hindi.translated >= 100, 'Hindi should translate a substantial core set of UI messages');
  assert.ok(hindi.percentage > 0 && hindi.percentage < 100,
    'Hindi must remain marked partial until the complete catalog is translated');
  for (const key of [
    'language', 'discovery', 'safety', 'like', 'pass', 'report', 'block',
    'search', 'relationshipGoal', 'accountTitle', 'signIn', 'createAccount',
    'email', 'password', 'chats', 'notificationCenter', 'authInvalidEmail',
    'authDeleteConfirm', 'partialTranslationHelp'
  ] as const) {
    assert.ok(!hindi.missing.includes(key), `Hindi core key "${key}" should be translated`);
  }
});


test('Vietnamese catalog covers core discovery, safety, account and messaging UI', () => {
  const vietnamese = getTranslationCoverage('vi');
  assert.ok(vietnamese.translated >= 100, 'Vietnamese should translate a substantial core set of UI messages');
  assert.ok(vietnamese.percentage > 0 && vietnamese.percentage < 100,
    'Vietnamese must remain marked partial until the complete catalog is translated');
  for (const key of [
    'language', 'discovery', 'safety', 'like', 'pass', 'report', 'block',
    'search', 'relationshipGoal', 'accountTitle', 'signIn', 'createAccount',
    'email', 'password', 'chats', 'notificationCenter', 'authInvalidEmail',
    'authDeleteConfirm', 'partialTranslationHelp'
  ] as const) {
    assert.ok(!vietnamese.missing.includes(key), `Vietnamese core key "${key}" should be translated`);
  }
});
