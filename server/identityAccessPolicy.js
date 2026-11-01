// Server-side authorization policy. Callers must populate every field from
// persisted provider/moderation state; request-body or client state is never valid.
export function canInteract({
  gender,
  status,
  environment,
  l3Status,
  l3ExpiresAt,
  now = Date.now()
}) {
  if (gender === 'female') return true;
  if (gender !== 'male') return false;

  // L2 is necessary but no longer sufficient. L3 has no production upload,
  // scan, moderator-decision or revocation pipeline yet, so current routes
  // intentionally fail closed for men until trusted L3 state is wired in.
  if (status !== 'verified' || environment !== 'live' || l3Status !== 'approved') return false;

  const expiry = typeof l3ExpiresAt === 'string' || l3ExpiresAt instanceof Date
    ? new Date(l3ExpiresAt).getTime()
    : Number.NaN;
  return Number.isFinite(expiry) && Number.isFinite(now) && expiry > now;
}
