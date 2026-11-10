import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8');
const brandIcon = await readFile(new URL('../public/icon.svg', import.meta.url), 'utf8');
const header = await readFile(new URL('../src/components/HeaderNav.tsx', import.meta.url), 'utf8');
const voicePanel = await readFile(new URL('../src/components/VoiceIntroRecorderPanel.tsx', import.meta.url), 'utf8');
const voiceApi = await readFile(new URL('../server/index.js', import.meta.url), 'utf8');

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


test('Vow brand icon is a scalable custom SVG and the app header uses it instead of the old flame glyph', () => {
  assert.match(brandIcon, /<svg[^>]+viewBox="0 0 512 512"/);
  assert.match(brandIcon, /<title[^>]*>Vow<\\/title>/);
  assert.match(brandIcon, /<linearGradient/);
  assert.match(brandIcon, /stroke-linecap="round"/);
  assert.match(header, /<img src="\\/icon\\.svg"/);
  assert.doesNotMatch(header, /\\bFlame\\b/);
});

test('voice introduction upload requires explicit current-version consent in both UI and API', () => {
  assert.match(voicePanel, /checked={consentAccepted}/);
  assert.match(voicePanel, /X-Vow-Voice-Intro-Consent-Version/);
  assert.match(voicePanel, /X-Vow-Voice-Intro-Consent': 'granted'/);
  assert.match(voicePanel, /disabled={busy \|\| !consentAccepted}/);
  assert.match(voiceApi, /isCurrentVoiceIntroConsentVersion\(req\.get\('x-vow-voice-intro-consent-version'\)\)/);
  assert.match(voiceApi, /voice_intro_consent_required/);
  assert.match(voiceApi, /consent\.withdrawn_at IS NULL/);
});
