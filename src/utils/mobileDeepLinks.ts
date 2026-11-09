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

type DeepLinkListener = (link: VowDeepLink) => void;
const deepLinkListeners = new Set<DeepLinkListener>();
const pendingDeepLinks: VowDeepLink[] = [];
const seenDeepLinks = new Set<string>();

export function publishVowDeepLink(rawUrl: unknown): void {
  const link = parseVowDeepLink(rawUrl);
  if (!link) return;
  const key = link.type === 'identity-return' ? null : link.type + ':' + link.token;
  if (key && seenDeepLinks.has(key)) return;
  if (key) {
    seenDeepLinks.add(key);
    if (seenDeepLinks.size > 32) seenDeepLinks.delete(seenDeepLinks.values().next().value as string);
  }
  if (deepLinkListeners.size === 0) {
    // Preserve a cold-start link until the account UI subscribes. Keep this
    // queue bounded because the URL may contain a one-time action token.
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
