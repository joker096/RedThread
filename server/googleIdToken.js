const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

export async function verifyGoogleIdTokenClaims({
  credential,
  expectedNonce,
  clientId,
  oauthClient,
  normalizeEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '',
  isValidEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
  now = Date.now()
}) {
  if (typeof clientId !== 'string' || !clientId.trim()) {
    throw new Error('google_sign_in_not_configured');
  }
  if (typeof credential !== 'string' || credential.length < 100 || credential.length > 20_000) {
    throw new Error('invalid_google_credential');
  }
  if (typeof expectedNonce !== 'string' || expectedNonce.length < 32 || expectedNonce.length > 128) {
    throw new Error('invalid_google_identity');
  }
  if (!oauthClient || typeof oauthClient.verifyIdToken !== 'function') {
    throw new Error('google_token_verifier_unavailable');
  }

  // OAuth2Client.verifyIdToken performs the cryptographic signature check and
  // validates Google's token envelope. Validate the security-sensitive claims
  // explicitly as a second boundary and keep them independently testable.
  const ticket = await oauthClient.verifyIdToken({ idToken: credential, audience: clientId });
  const payload = ticket?.getPayload?.();
  const email = normalizeEmail(payload?.email);
  const nowSeconds = Math.floor(now / 1000);
  const validAudience = payload?.aud === clientId ||
    (Array.isArray(payload?.aud) && payload.aud.includes(clientId));

  if (!payload ||
      !GOOGLE_ISSUERS.has(payload.iss) ||
      !validAudience ||
      !Number.isFinite(payload.exp) || payload.exp <= nowSeconds ||
      !Number.isFinite(payload.iat) || payload.iat > nowSeconds + 60 ||
      typeof payload.sub !== 'string' || payload.sub.length < 1 || payload.sub.length > 255 ||
      payload.email_verified !== true || !isValidEmail(email) ||
      payload.nonce !== expectedNonce) {
    throw new Error('invalid_google_identity');
  }

  return {
    subject: payload.sub,
    email,
    displayName: typeof payload.name === 'string' ? payload.name.trim().slice(0, 80) : ''
  };
}
