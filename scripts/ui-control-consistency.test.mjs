import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8');

test('Vow defines one shared readable control scale', () => {
  assert.match(css, /--vow-control-height:\s*2\.75rem/);
  assert.match(css, /--vow-control-font-size:\s*0\.875rem/);
  assert.match(css, /--vow-control-line-height:\s*1\.25rem/);
  assert.match(css, /--vow-label-font-size:\s*0\.8125rem/);
});

test('buttons and interactive button roles share accessible minimum height and typography', () => {
  assert.match(css, /:where\(button, \[role="button"\], input\[type="button"\], input\[type="submit"\], input\[type="reset"\]\)\s*\{[^}]*min-height:\s*var\(--vow-control-height\)[^}]*font-size:\s*var\(--vow-control-font-size\) !important/s);
});

test('form controls use a readable 16px baseline and labels use a consistent scale', () => {
  assert.match(css, /:where\(input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\), select, textarea\)\s*\{[^}]*font-size:\s*1rem !important/s);
  assert.match(css, /:where\(label, \.vow-field-label\)\s*\{[^}]*font-size:\s*var\(--vow-label-font-size\)/s);
});

test('navigation has a compact but consistent control size', () => {
  assert.match(css, /:where\(\[role="navigation"\]\) :where\(button, \[role="button"\]\)\s*\{[^}]*font-size:\s*0\.8125rem !important/s);
});
