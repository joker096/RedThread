export const CHAT_WINDOW_HOURS = 72;

export const isChatWindowExpired = (expiresAt: unknown, now = Date.now()): boolean => {
  if (typeof expiresAt !== 'string' || !Number.isFinite(now)) return false;
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) && expiry <= now;
};
