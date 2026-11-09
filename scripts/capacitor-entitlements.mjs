/**
 * Merge the Vow Universal Links entitlement without discarding capabilities
 * added by Xcode, Capacitor plugins, or a future release configuration.
 */
export function mergeAssociatedDomainsEntitlements(existing, host) {
  if (typeof existing !== 'string' || typeof host !== 'string' ||
      !/^[a-z0-9.-]+$/i.test(host) || !host.includes('.')) {
    throw new Error('invalid_associated_domains_input');
  }

  const trimmed = existing.trim();
  if (trimmed && (!trimmed.includes('<plist') || !/<dict>[\s\S]*<\/dict>/.test(trimmed))) {
    throw new Error('invalid_existing_entitlements_plist');
  }

  const entry = `applinks:${host.toLowerCase()}`;
  const keyPattern = /<key>com\.apple\.developer\.associated-domains<\/key>\s*<array>([\s\S]*?)<\/array>/;
  const match = trimmed.match(keyPattern);
  if (match) {
    const values = [...match[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map(item => item[1]);
    if (values.includes(entry)) return existing;
    const arrayBody = match[1].trim();
    const replacement = `<key>com.apple.developer.associated-domains</key>\n  <array>${arrayBody ? `\n${arrayBody}\n  ` : ''}<string>${entry}</string>\n  </array>`;
    return trimmed.replace(keyPattern, replacement) + (existing.endsWith('\n') ? '\n' : '');
  }

  if (trimmed) {
    const closing = /<\/dict>\s*<\/plist>\s*$/;
    if (!closing.test(trimmed)) throw new Error('invalid_existing_entitlements_plist');
    return trimmed.replace(closing, `  <key>com.apple.developer.associated-domains</key>\n  <array><string>${entry}</string></array>\n</dict>\n</plist>\n`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0">\n<dict>\n` +
    `  <key>com.apple.developer.associated-domains</key>\n` +
    `  <array><string>${entry}</string></array>\n` +
    `</dict>\n</plist>\n`;
}
