const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function emailDeliveryConfigured(env = process.env) {
  const configuredUrl = env.APP_URL || env.APP_ORIGIN;
  let validPublicUrl = false;
  try {
    const parsed = new URL(configuredUrl);
    const hostname = parsed.hostname.toLowerCase();
    validPublicUrl = env.NODE_ENV === 'production'
      ? parsed.protocol === 'https:' &&
        !['localhost', '127.0.0.1', '::1', 'example.com', 'example.org', 'example.net'].includes(hostname) &&
        !hostname.endsWith('.localhost')
      : ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    validPublicUrl = false;
  }

  const emailFrom = typeof env.EMAIL_FROM === 'string' ? env.EMAIL_FROM.trim() : '';
  const senderMatch = /^(?:[^<>\r\n]*\s*)?<([^<>]+)>$/.exec(emailFrom);
  const fromAddress = senderMatch ? senderMatch[1] : emailFrom;
  const domain = fromAddress.split('@')[1]?.toLowerCase() || '';
  const validSender = EMAIL_PATTERN.test(fromAddress) &&
    !['example.com', 'example.org', 'example.net', 'example.test', 'invalid'].includes(domain) &&
    !/[\r\n]/.test(emailFrom);

  return env.EMAIL_PROVIDER === 'resend' &&
    typeof env.RESEND_API_KEY === 'string' &&
    Boolean(env.RESEND_API_KEY.trim()) &&
    validSender &&
    validPublicUrl;
}
