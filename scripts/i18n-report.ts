import { getTranslationCoverage, LANGUAGE_OPTIONS } from '../src/i18n/LocaleProvider.tsx';

const locales = LANGUAGE_OPTIONS.filter(language => language.code !== 'auto');
console.log('Vow translation coverage (English catalog keys):');
for (const language of locales) {
  const coverage = getTranslationCoverage(language.code);
  console.log(`${language.code.padEnd(4)} ${String(coverage.percentage).padStart(3)}% (${coverage.translated}/${coverage.total}) — ${language.nativeName}`);
}
console.log('\nThis report is diagnostic. A locale is not fully localized until its UI, emails, questionnaires, accessibility text, RTL layout and native-speaker review are complete.');
