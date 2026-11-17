import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAssociatedDomainsEntitlements } from './capacitor-entitlements.mjs';

test('creates associated domains in an empty entitlements file', () => {
  const result = mergeAssociatedDomainsEntitlements('', 'links.example.com');
  assert.match(result, /<string>applinks:links\.example\.com<\/string>/);
});

test('preserves unrelated existing entitlements and associated domains', () => {
  const existing = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>aps-environment</key><string>development</string>
  <key>com.apple.developer.associated-domains</key>
  <array><string>webcredentials:example.com</string></array>
</dict></plist>
`;
  const result = mergeAssociatedDomainsEntitlements(existing, 'links.example.com');
  assert.match(result, /aps-environment/);
  assert.match(result, /development/);
  assert.match(result, /webcredentials:example.com/);
  assert.match(result, /applinks:links.example.com/);
});

test('is idempotent for the same app-link host', () => {
  const once = mergeAssociatedDomainsEntitlements('', 'links.example.com');
  assert.equal(mergeAssociatedDomainsEntitlements(once, 'links.example.com'), once);
});

test('rejects malformed existing plist and invalid host', () => {
  assert.throws(() => mergeAssociatedDomainsEntitlements('<plist><dict>', 'links.example.com'), /invalid_existing_entitlements_plist/);
  assert.throws(() => mergeAssociatedDomainsEntitlements('', 'https://links.example.com/path'), /invalid_associated_domains_input/);
});
