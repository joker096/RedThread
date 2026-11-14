export const VOICE_INTRO_CONSENT_VERSION = 1;

export function isCurrentVoiceIntroConsentVersion(value) {
  return value === String(VOICE_INTRO_CONSENT_VERSION);
}
