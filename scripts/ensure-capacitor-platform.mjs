import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mergeAssociatedDomainsEntitlements } from './capacitor-entitlements.mjs';
import { ensureAndroidRecordAudioPermission, ensureIosMicrophoneUsageDescription, ensureIosFilesystemPrivacyManifest, createEmptyIosPrivacyManifest, ensureIosPrivacyManifestXcodeResource } from './capacitor-audio-permissions.mjs';

const platform = process.argv[2];
if (!['android', 'ios'].includes(platform)) {
  console.error('Usage: node scripts/ensure-capacitor-platform.mjs <android|ios>');
  process.exit(2);
}

if (!existsSync(platform)) {
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const result = spawnSync(command, ['cap', 'add', platform], {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (result.error) {
    console.error('Could not generate Capacitor ' + platform + ' project:', result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function configuredAppLinkHost() {
  const raw = process.env.VOW_APP_LINK_HOST;
  if (!raw) return null;
  let parsed;
  try { parsed = new URL('https://' + raw); } catch { throw new Error('invalid_vow_app_link_host'); }
  if (parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' ||
      parsed.search || parsed.hash || parsed.hostname.toLowerCase() !== raw.toLowerCase() ||
      !parsed.hostname.includes('.')) {
    throw new Error('invalid_vow_app_link_host');
  }
  return parsed.hostname.toLowerCase();
}

function configureAndroidDeepLinks(host) {
  const manifestPath = join('android', 'app', 'src', 'main', 'AndroidManifest.xml');
  if (!existsSync(manifestPath)) throw new Error('android_manifest_missing_after_capacitor_add');
  let xml = readFileSync(manifestPath, 'utf8');
  const activityMatch = xml.match(/<activity\b(?=[^>]*android:name="[^"]*MainActivity")[^>]*>/);
  if (!activityMatch || activityMatch.index === undefined) throw new Error('android_main_activity_not_found');
  const activityStart = activityMatch.index + activityMatch[0].length;
  const activityEnd = xml.indexOf('</activity>', activityStart);
  if (activityEnd < 0) throw new Error('android_main_activity_close_tag_missing');
  const activityBody = xml.slice(activityStart, activityEnd);
  let insert = '';
  if (!activityBody.includes('android:scheme="vow"') || !activityBody.includes('android:host="identity"')) {
    insert += '\n            <intent-filter>\n' +
      '                <action android:name="android.intent.action.VIEW" />\n' +
      '                <category android:name="android.intent.category.DEFAULT" />\n' +
      '                <category android:name="android.intent.category.BROWSABLE" />\n' +
      '                <data android:scheme="vow" android:host="identity" android:path="/return" />\n' +
      '            </intent-filter>';
  }
  if (host && !activityBody.includes('android:host="' + host + '"')) {
    insert += '\n            <intent-filter android:autoVerify="true">\n' +
      '                <action android:name="android.intent.action.VIEW" />\n' +
      '                <category android:name="android.intent.category.DEFAULT" />\n' +
      '                <category android:name="android.intent.category.BROWSABLE" />\n' +
      '                <data android:scheme="https" android:host="' + host + '" android:path="/" />\n' +
      '            </intent-filter>';
  }
  if (insert) {
    xml = xml.slice(0, activityEnd) + insert + '\n        ' + xml.slice(activityEnd);
    writeFileSync(manifestPath, xml);
  }
}

function configureIosDeepLinks(host) {
  const plistPath = join('ios', 'App', 'App', 'Info.plist');
  if (!existsSync(plistPath)) throw new Error('ios_info_plist_missing_after_capacitor_add');
  let plist = readFileSync(plistPath, 'utf8');
  if (!plist.includes('<string>vow</string>')) {
    const urlType = '\n    <dict>\n' +
      '      <key>CFBundleURLName</key>\n' +
      '      <string>com.vow.app</string>\n' +
      '      <key>CFBundleURLSchemes</key>\n' +
      '      <array>\n        <string>vow</string>\n      </array>\n' +
      '    </dict>';
    const urlTypesPattern = new RegExp('<key>CFBundleURLTypes</key>\\s*<array>');
    if (urlTypesPattern.test(plist)) {
      plist = plist.replace(urlTypesPattern, match => match + urlType);
    } else {
      const bundleIdentifier = new RegExp('(<key>CFBundleIdentifier</key>\\s*<string>[^<]*</string>)');
      if (!bundleIdentifier.test(plist)) throw new Error('ios_bundle_identifier_entry_not_found');
      plist = plist.replace(bundleIdentifier, '$1\n    <key>CFBundleURLTypes</key>\n    <array>' + urlType + '\n    </array>');
    }
    writeFileSync(plistPath, plist);
  }

  if (host) {
    const entitlementsPath = join('ios', 'App', 'App', 'App.entitlements');
    const projectPath = join('ios', 'App', 'App.xcodeproj', 'project.pbxproj');
    if (!existsSync(projectPath)) throw new Error('ios_xcode_project_missing_after_capacitor_add');
    const existingEntitlements = existsSync(entitlementsPath)
      ? readFileSync(entitlementsPath, 'utf8')
      : '';
    const entitlements = mergeAssociatedDomainsEntitlements(existingEntitlements, host);
    if (entitlements !== existingEntitlements) writeFileSync(entitlementsPath, entitlements);
    let project = readFileSync(projectPath, 'utf8');
    if (!project.includes('CODE_SIGN_ENTITLEMENTS = App/App.entitlements;')) {
      project = project.replace(/buildSettings = \{/g,
        'buildSettings = {\n\t\t\t\tCODE_SIGN_ENTITLEMENTS = App/App.entitlements;');
      writeFileSync(projectPath, project);
    }
  }
}

function configureAndroidAudioPermission() {
  const manifestPath = join('android', 'app', 'src', 'main', 'AndroidManifest.xml');
  const current = readFileSync(manifestPath, 'utf8');
  const updated = ensureAndroidRecordAudioPermission(current);
  if (updated !== current) writeFileSync(manifestPath, updated);
}

function configureIosMicrophonePermission() {
  const appDirectory = join('ios', 'App', 'App');
  const plistPath = join(appDirectory, 'Info.plist');
  const current = readFileSync(plistPath, 'utf8');
  const updated = ensureIosMicrophoneUsageDescription(current);
  if (updated !== current) writeFileSync(plistPath, updated);

  const privacyManifestPath = join(appDirectory, 'PrivacyInfo.xcprivacy');
  const emptyPrivacyManifest = createEmptyIosPrivacyManifest();
  const currentPrivacy = existsSync(privacyManifestPath)
    ? readFileSync(privacyManifestPath, 'utf8')
    : emptyPrivacyManifest;
  const updatedPrivacy = ensureIosFilesystemPrivacyManifest(currentPrivacy);
  if (updatedPrivacy !== currentPrivacy) writeFileSync(privacyManifestPath, updatedPrivacy);

  const projectPath = join('ios', 'App', 'App.xcodeproj', 'project.pbxproj');
  if (!existsSync(projectPath)) throw new Error('ios_xcode_project_missing_after_capacitor_add');
  const currentProject = readFileSync(projectPath, 'utf8');
  const updatedProject = ensureIosPrivacyManifestXcodeResource(currentProject);
  if (updatedProject !== currentProject) writeFileSync(projectPath, updatedProject);
}

const appLinkHost = configuredAppLinkHost();
if (platform === 'android') {
  configureAndroidDeepLinks(appLinkHost);
  configureAndroidAudioPermission();
} else {
  configureIosDeepLinks(appLinkHost);
  configureIosMicrophonePermission();
}

console.log('Capacitor ' + platform + ' project configured for Vow links and microphone permission' +
  (appLinkHost ? ' on ' + appLinkHost + '.' : '; verified HTTPS app links await VOW_APP_LINK_HOST.'));
