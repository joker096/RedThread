export type VowDeepLink =
  | { type: 'verify-email'; token: string }
  | { type: 'reset-password'; token: string }
  | { type: 'identity-return' };

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,512}$/;

/**
 * Parse only explicitly supported Vow app links. Never accept arbitrary URLs,
 * credentials, duplicate token parameters, fragments or unknown query fields.
 */
export function parseVowDeepLink(rawUrl: unknown): VowDeepLink | null {
  if (typeof rawUrl !== 'string' || rawUrl.length < 1 || rawUrl.length > 2048) return null;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol !== 'vow:' || url.username || url.password || url.port || url.hash) return null;

  if (url.hostname === 'auth') {
    if (url.pathname !== '/verify-email' && url.pathname !== '/reset-password') return null;
    if ([...url.searchParams.keys()].some(key => key !== 'token')) return null;
    const tokens = url.searchParams.getAll('token');
    if (tokens.length !== 1 || !TOKEN_PATTERN.test(tokens[0])) return null;
    return url.pathname === '/verify-email'
      ? { type: 'verify-email', token: tokens[0] }
      : { type: 'reset-password', token: tokens[0] };
  }

  if (url.hostname === 'identity' && url.pathname === '/return' && url.search === '') {
    return { type: 'identity-return' };
  }

  return null;
}
