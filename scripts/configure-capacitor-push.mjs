import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const platform = process.argv[2];
if (!['android', 'ios'].includes(platform)) {
  console.error('Usage: node scripts/configure-capacitor-push.mjs <android|ios>');
  process.exit(2);
}

function ensureProjectEntitlements(projectPath) {
  if (!existsSync(projectPath)) throw new Error('ios_xcode_project_missing');
  let project = readFileSync(projectPath, 'utf8');
  if (!project.includes('CODE_SIGN_ENTITLEMENTS = App/App.entitlements;')) {
    project = project.replace(/buildSettings = \{/g,
      'buildSettings = {\n\t\t\t\tCODE_SIGN_ENTITLEMENTS = App/App.entitlements;');
    writeFileSync(projectPath, project);
  }
}

function configureIos() {
  const delegatePath = join('ios', 'App', 'App', 'AppDelegate.swift');
  if (!existsSync(delegatePath)) throw new Error('ios_app_delegate_missing');
  let delegate = readFileSync(delegatePath, 'utf8');
  if (!delegate.includes('.capacitorDidRegisterForRemoteNotifications')) {
    const callbacks = `
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }
`;
    const classEnd = delegate.lastIndexOf('}');
    if (classEnd < 0) throw new Error('ios_app_delegate_class_end_missing');
    delegate = delegate.slice(0, classEnd) + callbacks + delegate.slice(classEnd);
    writeFileSync(delegatePath, delegate);
  }

  const teamId = (process.env.APNS_TEAM_ID || '').trim();
  const environment = (process.env.APNS_ENVIRONMENT || '').trim();
  if (!teamId || !/^[A-Z0-9]{10}$/.test(teamId) ||
      !['sandbox', 'production'].includes(environment)) {
    console.log('APNs signing is not configured; leaving aps-environment entitlement disabled.');
    return;
  }
  const entitlementsPath = join('ios', 'App', 'App', 'App.entitlements');
  const projectPath = join('ios', 'App', 'App.xcodeproj', 'project.pbxproj');
  mkdirSync(dirname(entitlementsPath), { recursive: true });
  let entitlements = existsSync(entitlementsPath) ? readFileSync(entitlementsPath, 'utf8') : '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n</dict>\n</plist>\n';
  const value = environment === 'production' ? 'production' : 'development';
  const keyPattern = /<key>aps-environment<\/key>\s*<string>[^<]*<\/string>/;
  const entry = '<key>aps-environment</key>\n  <string>' + value + '</string>';
  if (keyPattern.test(entitlements)) entitlements = entitlements.replace(keyPattern, entry);
  else entitlements = entitlements.replace('</dict>', '  ' + entry + '\n</dict>');
  writeFileSync(entitlementsPath, entitlements);
  ensureProjectEntitlements(projectPath);
}

if (platform === 'ios') {
  configureIos();
} else {
  const firebaseConfig = join('android', 'app', 'google-services.json');
  if (!existsSync(firebaseConfig)) {
    console.log('Firebase Android config is not present; native push registration remains unavailable until google-services.json is supplied.');
  }
}
