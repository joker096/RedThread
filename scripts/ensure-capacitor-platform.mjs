import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

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
    console.error(\`Could not generate Capacitor \${platform} project:\`, result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function configureAndroidDeepLinks() {
  const manifestPath = join('android', 'app', 'src', 'main', 'AndroidManifest.xml');
  if (!existsSync(manifestPath)) throw new Error('android_manifest_missing_after_capacitor_add');
  let xml = readFileSync(manifestPath, 'utf8');
  const activityMatch = xml.match(/<activity\b(?=[^>]*android:name="[^"]*MainActivity")[^>]*>/);
  if (!activityMatch || activityMatch.index === undefined) throw new Error('android_main_activity_not_found');
  const activityStart = activityMatch.index + activityMatch[0].length;
  const activityEnd = xml.indexOf('</activity>', activityStart);
  if (activityEnd < 0) throw new Error('android_main_activity_close_tag_missing');
  const activityBody = xml.slice(activityStart, activityEnd);
  const filters = [
    { host: 'auth', path: '/' },
    { host: 'identity', path: '/return' }
  ];
  let insert = '';
  for (const item of filters) {
    if (activityBody.includes(\`android:host="\${item.host}"\`)) continue;
    insert += \`
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="vow" android:host="\${item.host}" android:pathPrefix="\${item.path}" />
            </intent-filter>\`;
  }
  if (insert) {
    xml = xml.slice(0, activityEnd) + insert + '\\n        ' + xml.slice(activityEnd);
    writeFileSync(manifestPath, xml);
  }
}

function configureIosDeepLinks() {
  const plistPath = join('ios', 'App', 'App', 'Info.plist');
  if (!existsSync(plistPath)) throw new Error('ios_info_plist_missing_after_capacitor_add');
  let plist = readFileSync(plistPath, 'utf8');
  if (/<string>vow<\/string>/.test(plist)) return;
  const urlType = \`
    <dict>
      <key>CFBundleURLName</key>
      <string>com.vow.app</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>vow</string>
      </array>
    </dict>\`;
  if (/<key>CFBundleURLTypes<\/key>\s*<array>/.test(plist)) {
    plist = plist.replace(/(<key>CFBundleURLTypes<\/key>\s*<array>)/, \`$1\${urlType}\`);
  } else {
    const bundleIdentifier = /(<key>CFBundleIdentifier<\/key>\s*<string>[^<]*<\/string>)/;
    if (!bundleIdentifier.test(plist)) throw new Error('ios_bundle_identifier_entry_not_found');
    plist = plist.replace(bundleIdentifier, \`$1
    <key>CFBundleURLTypes</key>
    <array>\${urlType}
    </array>\`);
  }
  writeFileSync(plistPath, plist);
}

if (platform === 'android') configureAndroidDeepLinks();
else configureIosDeepLinks();

console.log(\`Capacitor \${platform} project is ready with Vow custom URL handlers.\`);
