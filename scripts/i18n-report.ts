import { getTranslationCoverage, getTranslationPlaceholderMismatches, LANGUAGE_OPTIONS } from '../src/i18n/LocaleProvider.tsx';

const locales = LANGUAGE_OPTIONS.filter(language => language.code !== 'auto');
console.log('Vow translation coverage (English catalog keys):');
for (const language of locales) {
  const coverage = getTranslationCoverage(language.code);
  console.log(`${language.code.padEnd(4)} ${String(coverage.percentage).padStart(3)}% (${coverage.translated}/${coverage.total}) — ${language.nativeName}`);
}

console.log('\nInterpolation placeholder diagnostics:');
let placeholderMismatchCount = 0;
for (const language of locales) {
  const mismatches = getTranslationPlaceholderMismatches(language.code);
  if (mismatches.length === 0) continue;
  placeholderMismatchCount += mismatches.length;
  console.warn(`\n${language.code} — ${mismatches.length} message(s) have placeholder mismatches:`);
  for (const mismatch of mismatches) {
    console.warn(`  ${String(mismatch.key)}: expected {${mismatch.expected.join(', ')}}, found {${mismatch.actual.join(', ')}}`);
  }
}
if (placeholderMismatchCount === 0) {
  console.log('No placeholder mismatches found in available translated messages.');
} else {
  console.warn(`Total placeholder mismatches: ${placeholderMismatchCount}. Review before releasing affected locales.`);
}

console.log('\nThis report is diagnostic. A locale is not fully localized until its UI, emails, questionnaires, accessibility text, RTL layout and native-speaker review are complete.');
