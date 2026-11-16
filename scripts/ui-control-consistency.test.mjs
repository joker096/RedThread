import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8');
const brandIcon = await readFile(new URL('../public/icon.svg', import.meta.url), 'utf8');
const brandMark = await readFile(new URL('../public/vow-mark.svg', import.meta.url), 'utf8');
const iconAttribution = await readFile(new URL('../public/ICON_ATTRIBUTION.md', import.meta.url), 'utf8');
const header = await readFile(new URL('../src/components/HeaderNav.tsx', import.meta.url), 'utf8');
const voicePanel = await readFile(new URL('../src/components/VoiceIntroRecorderPanel.tsx', import.meta.url), 'utf8');
const voiceApi = await readFile(new URL('../server/index.js', import.meta.url), 'utf8');
const voiceConsent = await readFile(new URL('../server/voiceIntroConsent.js', import.meta.url), 'utf8');
const voiceConsentMigration = await readFile(new URL('../server/migrations/230_profile_voice_intro_consents.sql', import.meta.url), 'utf8');
const voiceConsentIntegrationTest = await readFile(new URL('../server/voiceIntroConsentSchema.integration.test.js', import.meta.url), 'utf8');

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
  assert.ok(brandIcon.includes('viewBox="0 0 512 512"'));
  assert.ok(brandIcon.includes('<title id="title">Vow</title>'));
  assert.ok(brandIcon.includes('<linearGradient'));
  assert.ok(brandIcon.includes('<rect width="512" height="512" fill="url(#bg)"/>'));
  assert.ok(brandIcon.includes('stroke-linecap="round"'));
  assert.ok(header.includes('<img src="/icon.svg"'));
  assert.equal(header.includes('Flame'), false);
  assert.ok(brandIcon.includes('translate(58 36) scale(16.5)'));
  assert.ok(brandMark.includes('translate(58 36) scale(16.5)'), 'adaptive foreground stays within the launcher safe zone');
  assert.ok(iconAttribution.includes('ISC License'));
  assert.ok(iconAttribution.includes('heart-handshake.svg'));
});

test('voice introduction upload requires explicit current-version consent in both UI and API', () => {
  assert.ok(voicePanel.includes('checked={consentAccepted}'));
  assert.ok(voicePanel.includes('X-Vow-Voice-Intro-Consent-Version'));
  assert.ok(voicePanel.includes("'X-Vow-Voice-Intro-Consent': 'granted'"));
  assert.ok(voicePanel.includes('disabled={busy || !consentAccepted}'));
  assert.ok(voiceApi.includes("isCurrentVoiceIntroConsentVersion(req.get('x-vow-voice-intro-consent-version'))"));
  assert.ok(voiceApi.includes('voice_intro_consent_required'));
  assert.ok(voiceApi.includes('consent.withdrawn_at IS NULL'));
});

test('voice consent versions stay aligned and legacy clips are purged rather than grandfathered', () => {
  assert.ok(voiceConsent.includes('VOICE_INTRO_CONSENT_VERSION = 1'));
  assert.ok(voicePanel.includes('VOICE_INTRO_CONSENT_VERSION = 1'));
  assert.ok(voiceConsentMigration.includes('INSERT INTO private_voice_intro_purge_queue'));
  assert.ok(voiceConsentMigration.includes('DELETE FROM profile_voice_intros'));
  assert.ok(voiceConsentMigration.includes('profile_voice_intro_consent_events_immutable'));
});

test('discovery availability and moderator playback both require active current-version consent', () => {
  assert.ok(voiceApi.includes('voice_consent.consent_version = ${VOICE_INTRO_CONSENT_VERSION}'));
  assert.ok(voiceApi.includes('c.consent_version = ${VOICE_INTRO_CONSENT_VERSION}'));
  assert.ok(voiceApi.includes('voice_intro_media_viewed'));
});

test('voice consent cannot be reactivated without a fresh grant event', () => {
  assert.ok(voiceConsentMigration.includes('OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS NULL'));
  assert.ok(voiceConsentMigration.includes('NEW.granted_txid = txid_current()'));
  assert.ok(voicePanel.includes('disabled={busy}'));
});

test('consent integration tests compare timestamps inside PostgreSQL without JavaScript precision loss', () => {
  assert.ok(voiceConsentIntegrationTest.includes("SELECT user_id, user_id, 'granted', consent_version, granted_at"));
  assert.ok(voiceConsentIntegrationTest.includes("SELECT user_id, user_id, 'withdrawn', consent_version, withdrawn_at"));
  assert.equal(voiceConsentIntegrationTest.includes("VALUES ($1, $1, 'granted', 1, $2)"), false);
});
