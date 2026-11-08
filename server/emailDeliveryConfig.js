const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function emailDeliveryConfigured(env = process.env) {
  const configuredUrl = env.APP_URL || env.APP_ORIGIN;
  let validPublicUrl = false;
  try {
    const parsed = new URL(configuredUrl);
    const hostname = parsed.hostname.toLowerCase();
    const exampleHost = ['example.com', 'example.org', 'example.net'].includes(hostname) ||
      hostname.endsWith('.example.com') || hostname.endsWith('.example.org') || hostname.endsWith('.example.net');
    const reservedHost = ['localhost', '127.0.0.1', '::1', '[::1]', 'example.com', 'example.org', 'example.net'].includes(hostname) ||
      hostname.endsWith('.localhost') || hostname.endsWith('.example.com') ||
      hostname.endsWith('.example.org') || hostname.endsWith('.example.net') ||
      hostname.endsWith('.test') || hostname.endsWith('.invalid');
    validPublicUrl = env.NODE_ENV === 'production'
      ? parsed.protocol === 'https:' && !reservedHost
      : ['http:', 'https:'].includes(parsed.protocol) && !exampleHost;
  } catch {
    validPublicUrl = false;
  }

  const emailFrom = typeof env.EMAIL_FROM === 'string' ? env.EMAIL_FROM.trim() : '';
  const senderMatch = /^(?:[^<>\r\n]*\s*)?<([^<>]+)>$/.exec(emailFrom);
  const fromAddress = senderMatch ? senderMatch[1] : emailFrom;
  const domain = fromAddress.split('@')[1]?.toLowerCase() || '';
  const reservedSenderDomain = ['example.com', 'example.org', 'example.net', 'example.test', 'invalid'].includes(domain) ||
    domain.endsWith('.example.com') || domain.endsWith('.example.org') || domain.endsWith('.example.net') ||
    domain.endsWith('.test') || domain.endsWith('.invalid');
  const validSender = EMAIL_PATTERN.test(fromAddress) && !reservedSenderDomain && !/[\r\n]/.test(emailFrom);

  return env.EMAIL_PROVIDER === 'resend' &&
    typeof env.RESEND_API_KEY === 'string' &&
    Boolean(env.RESEND_API_KEY.trim()) &&
    validSender &&
    validPublicUrl;
}
