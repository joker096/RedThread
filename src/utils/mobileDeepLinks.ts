export type VowDeepLink =
  | { type: 'verify-email'; token: string }
  | { type: 'reset-password'; token: string }
  | { type: 'identity-return' };

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,512}$/;

/**
 * Parse only verified HTTPS app links for token-bearing account actions.
 * The custom vow:// scheme is deliberately restricted to non-secret returns.
 */
export function parseVowDeepLink(rawUrl: unknown, allowedHost?: string): VowDeepLink | null {
  if (typeof rawUrl !== 'string' || rawUrl.length < 1 || rawUrl.length > 2048) return null;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.username || url.password || url.port || url.hash) return null;

  if (url.protocol === 'vow:') {
    if (url.hostname === 'identity' && url.pathname === '/return' && url.search === '') {
      return { type: 'identity-return' };
    }
    return null;
  }

  if (url.protocol !== 'https:' || !allowedHost || url.pathname !== '/') return null;
  let expectedHost: string;
  try {
    const configured = new URL('https://' + allowedHost);
    if (configured.username || configured.password || configured.port ||
        configured.pathname !== '/' || configured.search || configured.hash ||
        configured.hostname.toLowerCase() !== allowedHost.toLowerCase()) return null;
    expectedHost = configured.hostname.toLowerCase();
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== expectedHost) return null;

  if ([...url.searchParams.keys()].some(key =>
    !['verifyEmail', 'resetPassword', 'identityVerification'].includes(key))) return null;
  const identityReturns = url.searchParams.getAll('identityVerification');
  if (identityReturns.length > 0) {
    return identityReturns.length === 1 && identityReturns[0] === 'return' &&
      url.searchParams.size === 1 ? { type: 'identity-return' } : null;
  }
  const verifyTokens = url.searchParams.getAll('verifyEmail');
  const resetTokens = url.searchParams.getAll('resetPassword');
  if (verifyTokens.length + resetTokens.length !== 1) return null;
  if (verifyTokens.length === 1 && TOKEN_PATTERN.test(verifyTokens[0])) {
    return { type: 'verify-email', token: verifyTokens[0] };
  }
  if (resetTokens.length === 1 && TOKEN_PATTERN.test(resetTokens[0])) {
    return { type: 'reset-password', token: resetTokens[0] };
  }
  return null;
}

type DeepLinkListener = (link: VowDeepLink) => void;
const deepLinkListeners = new Set<DeepLinkListener>();
const pendingDeepLinks: VowDeepLink[] = [];
const seenDeepLinks = new Set<string>();

export function publishVowDeepLink(rawUrl: unknown, allowedHost?: string): void {
  const link = parseVowDeepLink(rawUrl, allowedHost);
  if (!link) return;
  const key = link.type === 'identity-return' ? null : link.type + ':' + link.token;
  if (key && seenDeepLinks.has(key)) return;
  if (key) {
    seenDeepLinks.add(key);
    if (seenDeepLinks.size > 32) seenDeepLinks.delete(seenDeepLinks.values().next().value as string);
  }
  if (deepLinkListeners.size === 0) {
    // Preserve a cold-start link until the account UI subscribes. Keep this
    // queue bounded because it may contain a one-time action token.
    if (pendingDeepLinks.length < 3) pendingDeepLinks.push(link);
    return;
  }
  for (const listener of deepLinkListeners) listener(link);
}

export function subscribeVowDeepLinks(listener: DeepLinkListener): () => void {
  deepLinkListeners.add(listener);
  const queued = pendingDeepLinks.splice(0, pendingDeepLinks.length);
  for (const link of queued) listener(link);
  return () => deepLinkListeners.delete(listener);
}
