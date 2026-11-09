# Vow Native Authentication Contract

Status: implemented on the dedicated mobile feature branch; CI and Browser E2E passed on commit 2695241.  
Clients: official Android and iOS apps only.  
Existing browser cookie authentication remains unchanged.

## Token model

- Tokens are opaque random 256-bit values; the server stores only SHA-256 hashes.
- Access token lifetime: 10 minutes.
- Refresh token lifetime: 30 days, absolute; refreshing does not extend the absolute expiry.
- The native app stores the refresh token in iOS Keychain / Android Keystore-backed secure storage. Access tokens remain in memory where practical.
- The app never writes either token to localStorage, IndexedDB, logs, crash reports, analytics or deep-link URLs.
- Each installation has a random UUID device identifier and a bounded display name. Device metadata is informational, not proof of device integrity.
- Tokens are scoped to one mobile session and cannot authenticate browser cookie routes by being copied into a cookie.

## Implemented endpoints

### POST /api/mobile/auth/login

Input: email, password, platform (`android` or `ios`), deviceId (UUID), deviceName (1–80 chars).

Success: `{ user, accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt }`.

The handler reuses the existing password verification, account status, email-verification and account-safety locking rules. It creates only a mobile session and never sets the browser `nit_session` cookie.

### POST /api/mobile/auth/refresh

Input: refresh token in the Authorization Bearer header, plus the deviceId.

- Lock the matching session row inside a transaction.
- Require the session to be active, unexpired and bound to the same deviceId.
- Rotate the refresh token and access token atomically.
- Append the consumed refresh-token hash to `mobile_refresh_token_history`.
- A replayed consumed refresh token revokes all mobile sessions for that account with reason `refresh_reuse`, then returns 401.
- Concurrent refresh requests must not both succeed; the second request must be treated as replay and revoke the affected account's mobile sessions.
- Never return a replacement token unless the transaction commits.

### GET /api/mobile/auth/me

Requires a valid access token. Reuses current active-account and email-verification policy and returns the same public user projection as `/api/auth/me`.

### POST /api/mobile/auth/logout

Requires a valid access token and device-bound session. Revokes only the current mobile session. The client deletes locally stored tokens even if the request fails.

### POST /api/mobile/auth/logout-all

Requires a valid access token. Revokes every mobile session for the current account. Password reset, account suspension/deletion and security response must also revoke mobile sessions.

## Origin / CSRF boundary

- Keep `validateRequestOrigin` strict for cookie-authenticated browser requests.
- Native endpoints must use an explicit mobile-client origin allowlist for requests that carry a browser Origin.
- For requests without Origin, permit only native endpoints with the required token credential; never treat a custom User-Agent or a client-supplied platform string as authentication.
- Do not add wildcard CORS. Do not let a bearer credential silently fall back to cookie authentication.
- Browser routes that mutate state must continue to require the configured browser Origin even when a browser session cookie exists.
- The refresh endpoint's bearer credential must be a refresh token, not an access token.

## Database model already added

Migration `212_mobile_sessions.sql` creates:
- `mobile_sessions`: one row per device session, token hashes, platform/device metadata, absolute expiry and revocation state.
- `mobile_refresh_token_history`: append-only consumed refresh-token hashes used to detect replay.

The history table rejects direct updates and deletes, while allowing FK-driven cleanup when the owning session/account is deleted. Token values are never persisted.

## Required integration tests before native clients use these endpoints

1. Browser cookie login/session/logout remains unchanged.
2. Mobile login rejects invalid credentials, unverified email and inactive accounts.
3. Access token expiry and wrong token type are rejected.
4. Refresh rotates both tokens atomically and old access/refresh credentials stop working.
5. Parallel refresh replay revokes mobile sessions and cannot return two valid token pairs.
6. Refresh token bound to a different device is rejected.
7. Logout revokes only the current device; logout-all revokes every device.
8. Password reset, account suspension and account deletion invalidate mobile sessions.
9. Origin-less browser mutations and untrusted browser Origins remain rejected.
10. Mobile refresh history cannot be edited; account deletion cascades cleanly.

## Implementation notes

- Native registration, login, email verification/resend and password-reset request/completion are implemented under `/api/mobile/auth`.
- Native bearer access tokens are accepted by the shared `requireSession` middleware, so existing protected profile, discovery, match, notification, moderation and gift API routes can be reused without weakening browser cookie sessions.
- State-changing shared API routes accept native bearer requests only when the token is valid and the optional Origin is on the explicit mobile allowlist. Browser cookie mutations still require the exact configured `APP_ORIGIN`.
- CORS is allowlisted for `capacitor://localhost`, `https://localhost`, `http://localhost` and explicit `MOBILE_ALLOWED_ORIGINS` entries. Credentialed CORS is not enabled.
- At most 10 active mobile sessions are allowed per account. A new login on an installation revokes its prior session, backed by a unique active-device index.
- Password reset, moderator suspension and account deletion revoke mobile sessions.
- The test suite exercises registration, verification, login, protected shared API access, CORS preflight, refresh rotation, replay and concurrent refresh, device mismatch, logout, logout-all, password reset and same-device replacement.
- Refresh requests must be serialized in the client. A concurrent second refresh is treated as replay and revokes all sessions for the account by design.

CI and Browser E2E both passed on the same commit `2695241ae58d6e072d446ccb4c103688b337883f`. This validates the server foundation; native app integration and physical-device tests remain outstanding.
