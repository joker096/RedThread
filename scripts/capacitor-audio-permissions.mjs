export function ensureAndroidRecordAudioPermission(xml) {
  if (typeof xml !== 'string' || !xml.includes('<manifest')) {
    throw new TypeError('android manifest XML is invalid');
  }
  if (/\bandroid:name=["']android\.permission\.RECORD_AUDIO["']/.test(xml)) return xml;
  const applicationIndex = xml.indexOf('<application');
  if (applicationIndex < 0) throw new Error('android_application_tag_missing');
  return xml.slice(0, applicationIndex) +
    '    <uses-permission android:name="android.permission.RECORD_AUDIO" />\n    ' +
    xml.slice(applicationIndex);
}

export function ensureIosMicrophoneUsageDescription(plist) {
  if (typeof plist !== 'string' || !plist.includes('<plist') || !plist.includes('<dict>')) {
    throw new TypeError('iOS Info.plist XML is invalid');
  }
  if (plist.includes('<key>NSMicrophoneUsageDescription</key>')) return plist;
  const rootClose = plist.lastIndexOf('</dict>');
  if (rootClose < 0) throw new Error('ios_root_dictionary_close_tag_missing');
  const entry = [
    '    <key>NSMicrophoneUsageDescription</key>',
    '    <string>Vow uses the microphone only when you choose to record a short voice introduction for your profile.</string>',
    ''
  ].join('\n');
  return plist.slice(0, rootClose) + entry + plist.slice(rootClose);
}

export function ensureIosFilesystemPrivacyManifest(plist) {
  if (typeof plist !== 'string' || !plist.includes('<plist') || !plist.includes('<dict>')) {
    throw new TypeError('iOS privacy manifest XML is invalid');
  }
  const category = '<string>NSPrivacyAccessedAPICategoryFileTimestamp</string>';
  const reason = '<string>C617.1</string>';
  if (plist.includes(category) && plist.includes(reason)) return plist;
  if (plist.includes('<key>NSPrivacyAccessedAPITypes</key>')) {
    throw new Error('ios_privacy_manifest_requires_manual_merge');
  }
  const rootClose = plist.lastIndexOf('</dict>');
  if (rootClose < 0) throw new Error('ios_privacy_manifest_root_dictionary_close_tag_missing');
  const entry = [
    '    <key>NSPrivacyAccessedAPITypes</key>',
    '    <array>',
    '      <dict>',
    '        <key>NSPrivacyAccessedAPIType</key>',
    '        ' + category,
    '        <key>NSPrivacyAccessedAPITypeReasons</key>',
    '        <array>' + reason + '</array>',
    '      </dict>',
    '    </array>',
    ''
  ].join('\n');
  return plist.slice(0, rootClose) + entry + plist.slice(rootClose);
}


export function createEmptyIosPrivacyManifest() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict></dict></plist>
`;
}


export function ensureIosPrivacyManifestXcodeResource(project) {
  if (typeof project !== 'string' || !project.includes('/* Begin PBXBuildFile section */')) {
    throw new TypeError('iOS Xcode project is invalid');
  }
  const buildFileId = 'A11CE0000000000000000001';
  const fileReferenceId = 'A11CE0000000000000000002';
  if (project.includes('PrivacyInfo.xcprivacy')) {
    if (project.includes(buildFileId) && project.includes(fileReferenceId)) return project;
    throw new Error('ios_privacy_manifest_xcode_registration_incomplete');
  }
  if (project.includes(buildFileId) || project.includes(fileReferenceId)) {
    throw new Error('ios_privacy_manifest_xcode_reference_id_collision');
  }
  let updated = project;

  const buildFileEnd = '/* End PBXBuildFile section */';
  const fileReferenceEnd = '/* End PBXFileReference section */';
  if (!updated.includes(buildFileEnd) || !updated.includes(fileReferenceEnd)) {
    throw new Error('ios_xcode_project_file_sections_missing');
  }
  updated = updated.replace(buildFileEnd,
    `\t\t${buildFileId} /* PrivacyInfo.xcprivacy in Resources */ = {isa = PBXBuildFile; fileRef = ${fileReferenceId} /* PrivacyInfo.xcprivacy */; };\n\t${buildFileEnd}`);
  updated = updated.replace(fileReferenceEnd,
    `\t\t${fileReferenceId} /* PrivacyInfo.xcprivacy */ = {isa = PBXFileReference; lastKnownFileType = text.xml; path = PrivacyInfo.xcprivacy; sourceTree = "<group>"; };\n\t${fileReferenceEnd}`);

  const appGroup = /(\b[A-F0-9]{24} \/\* App \*\/ = \{\s*isa = PBXGroup;\s*children = \(\n)/;
  if (!appGroup.test(updated)) throw new Error('ios_xcode_app_group_not_found');
  updated = updated.replace(appGroup, `$1\t\t\t\t${fileReferenceId} /* PrivacyInfo.xcprivacy */,\n`);

  const resourcesPhase = /(\b[A-F0-9]{24} \/\* Resources \*\/ = \{[\s\S]*?isa = PBXResourcesBuildPhase;[\s\S]*?files = \(\n)/;
  if (!resourcesPhase.test(updated)) throw new Error('ios_xcode_resources_phase_not_found');
  updated = updated.replace(resourcesPhase, `$1\t\t\t\t${buildFileId} /* PrivacyInfo.xcprivacy in Resources */,\n`);
  return updated;
}
