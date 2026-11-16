import test from 'node:test';
import assert from 'node:assert/strict';
import { isCurrentVoiceIntroConsentVersion, VOICE_INTRO_CONSENT_VERSION } from './voiceIntroConsent.js';

test('voice introduction consent requires the exact current version', () => {
  assert.equal(VOICE_INTRO_CONSENT_VERSION, 1);
  assert.equal(isCurrentVoiceIntroConsentVersion('1'), true);
  for (const value of [undefined, null, '', '0', '2', '01', 1, '1.0']) {
    assert.equal(isCurrentVoiceIntroConsentVersion(value), false);
  }
});
