import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve('scripts/configure-capacitor-push.mjs');

function makeIosProject() {
  const root = mkdtempSync(join(tmpdir(), 'vow-push-ios-'));
  mkdirSync(join(root, 'ios', 'App', 'App'), { recursive: true });
  mkdirSync(join(root, 'ios', 'App', 'App.xcodeproj'), { recursive: true });
  writeFileSync(join(root, 'ios', 'App', 'App', 'AppDelegate.swift'),
    'import UIKit\n@UIApplicationMain\nclass AppDelegate: UIResponder, UIApplicationDelegate {\n}\n');
  writeFileSync(join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'),
    'buildSettings = {\n};\nbuildSettings = {\n};\n');
  return root;
}

test('iOS push setup installs AppDelegate callbacks and development entitlement idempotently', () => {
  const root = makeIosProject();
  try {
    const env = { ...process.env, APNS_TEAM_ID: 'ABCDEFGHIJ', APNS_ENVIRONMENT: 'sandbox' };
    for (let i = 0; i < 2; i++) {
      const result = spawnSync(process.execPath, [script, 'ios'], { cwd: root, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    const delegate = readFileSync(join(root, 'ios', 'App', 'App', 'AppDelegate.swift'), 'utf8');
    const entitlements = readFileSync(join(root, 'ios', 'App', 'App', 'App.entitlements'), 'utf8');
    const project = readFileSync(join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'), 'utf8');
    assert.equal((delegate.match(/capacitorDidRegisterForRemoteNotifications/g) || []).length, 1);
    assert.match(delegate, /capacitorDidFailToRegisterForRemoteNotifications/);
    assert.match(entitlements, /<string>development<\/string>/);
    assert.match(project, /CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('iOS push setup leaves signing entitlement disabled without an Apple team', () => {
  const root = makeIosProject();
  try {
    const env = { ...process.env };
    delete env.APNS_TEAM_ID;
    delete env.APNS_ENVIRONMENT;
    const result = spawnSync(process.execPath, [script, 'ios'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const delegate = readFileSync(join(root, 'ios', 'App', 'AppDelegate.swift'), 'utf8');
    assert.match(delegate, /capacitorDidRegisterForRemoteNotifications/);
    assert.equal(readFileSync(join(root, 'ios', 'App', 'App', 'App.entitlements'), 'utf8').includes('aps-environment'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Android push setup does not fail when Firebase credentials are not supplied', () => {
  const root = mkdtempSync(join(tmpdir(), 'vow-push-android-'));
  try {
    mkdirSync(join(root, 'android', 'app'), { recursive: true });
    const result = spawnSync(process.execPath, [script, 'android'], { cwd: root, env: { ...process.env }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /registration remains unavailable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
