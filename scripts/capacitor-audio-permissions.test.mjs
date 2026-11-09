import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureAndroidRecordAudioPermission, ensureIosMicrophoneUsageDescription, ensureIosFilesystemPrivacyManifest, createEmptyIosPrivacyManifest } from './capacitor-audio-permissions.mjs';

test('adds Android microphone permission once and preserves existing permissions', () => {
  const source = '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application /></manifest>';
  const once = ensureAndroidRecordAudioPermission(source);
  assert.match(once, /android\.permission\.RECORD_AUDIO/);
  assert.equal(ensureAndroidRecordAudioPermission(once), once);
  assert.ok(once.indexOf('uses-permission') < once.indexOf('<application'));
});

test('adds iOS microphone purpose text once to the root Info.plist dictionary', () => {
  const source = '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.vow.app</string></dict></plist>';
  const once = ensureIosMicrophoneUsageDescription(source);
  assert.match(once, /NSMicrophoneUsageDescription/);
  assert.match(once, /short voice introduction/);
  assert.equal(ensureIosMicrophoneUsageDescription(once), once);
});

test('rejects malformed native permission manifests rather than silently skipping permissions', () => {
  assert.throws(() => ensureAndroidRecordAudioPermission('<manifest></manifest>'), /android_application_tag_missing/);
  assert.throws(() => ensureIosMicrophoneUsageDescription('<plist><dict></plist>'), /ios_root_dictionary_close_tag_missing/);
});

test('adds the required iOS file timestamp privacy reason without overwriting existing manifests', () => {
  const source = '<?xml version="1.0"?><plist version="1.0"><dict><key>NSPrivacyTracking</key><false/></dict></plist>';
  const once = ensureIosFilesystemPrivacyManifest(source);
  assert.match(once, /NSPrivacyAccessedAPICategoryFileTimestamp/);
  assert.match(once, /C617\.1/);
  assert.match(once, /NSPrivacyTracking/);
  assert.equal(ensureIosFilesystemPrivacyManifest(once), once);
});

test('refuses to silently overwrite a partially configured iOS privacy manifest', () => {
  const source = '<plist><dict><key>NSPrivacyAccessedAPITypes</key><array/></dict></plist>';
  assert.throws(() => ensureIosFilesystemPrivacyManifest(source), /requires_manual_merge/);
});

test('creates a valid empty iOS privacy manifest template with real XML whitespace', () => {
  const source = createEmptyIosPrivacyManifest();
  assert.match(source, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<plist version="1\.0">/);
  assert.equal(source.includes(String.fromCharCode(92) + 'n'), false);
  const updated = ensureIosFilesystemPrivacyManifest(source);
  assert.match(updated, /<plist version="1\.0">/);
  assert.match(updated, /NSPrivacyAccessedAPICategoryFileTimestamp/);
});
