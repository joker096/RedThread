# Vow Native Authentication Contract

Status: implemented on the dedicated mobile feature branch; regression checks are run against the exact branch HEAD.
Clients: official Android and iOS apps only.
Existing browser cookie authentication remains separate.

## Token model

- Tokens are opaque random 256-bit values; the server stores only SHA-256 hashes.
- Access token lifetime: 10 minutes.
- Refresh token lifetime: 30 days, absolute; refreshing does not extend the absolute expiry.
- The native app stores the refresh token in iOS Keychain / Android Keystore-backed secure storage. Access tokens remain in memory.
- The app does not write tokens to localStorage, IndexedDB, analytics or deep-link URLs.
- Each installation has a random UUID device identifier and a bounded display name. Device metadata is informational, not proof of device integrity.
- Tokens are scoped to one mobile session and do not authenticate browser cookie routes.

## Implemented endpoints

### POST /api/mobile/auth/register

Creates the account/profile under the existing account-reuse and safety rules. If email verification is required, no mobile session is issued until the account is verified.

### POST /api/mobile/auth/login

Input: email, password, platform (`android` or `ios`), deviceId (UUID), deviceName (1–80 chars).

Success: `{ user, accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt }`.

The handler reuses password verification, account status, email-verification and account-safety locking rules. It creates only a mobile session and never sets the browser `nit_session` cookie. A maximum of 10 active mobile sessions is enforced per account; a new login on the same installation replaces its prior session.

### POST /api/mobile/auth/refresh

Input: refresh token in the Authorization Bearer header, plus the device context.

- Lock the account/session rows inside a transaction.
- Require the session to be active, unexpired and bound to the same deviceId and platform.
- Rotate the refresh token and access token atomically.
- Append the consumed refresh-token hash to `mobile_refresh_token_history`.
- A replayed consumed refresh token revokes all mobile sessions for that account with reason `refresh_reuse`, then returns 401.
- Concurrent refresh requests cannot both succeed; the second request is treated as replay and revokes the account's mobile sessions.
- Never return a replacement token unless the transaction commits.

### GET /api/mobile/auth/me

Requires a valid access token. Reuses active-account and email-verification policy and returns the same public user projection as `/api/auth/me`.

### POST /api/mobile/auth/logout

Requires a valid access token. Revokes only the current mobile session. The client deletes locally stored credentials even if the server request fails.

### POST /api/mobile/auth/logout-all

Requires a valid access token. Revokes every mobile session for the current account.

### Email verification and password reset

Native routes implement verification, verification resend, password-reset request and password-reset completion. Password reset revokes all browser and mobile sessions for the account.

## Origin / CSRF boundary

- Keep `validateRequestOrigin` strict for cookie-authenticated browser requests.
- Native endpoints use an explicit mobile-origin allowlist when a browser Origin is present.
- Dedicated native auth routes can receive Origin-less JSON requests because login/registration/recovery carry their own credentials or one-time tokens. A client-supplied platform string or User-Agent is never authentication.
- Origin-less state-changing shared API requests require a valid native access bearer token. If an Origin is present, it must be the configured browser origin or an allowlisted native origin.
- Do not add wildcard CORS or credentialed CORS. Do not let a bearer credential silently fall back to cookie authentication.
- Browser routes that mutate state must continue to require the configured browser Origin even when a browser session cookie exists.
- Refresh requires a refresh token; an access token is rejected.

## Database model

Migration `212_mobile_sessions.sql` creates:
- `mobile_sessions`: one row per device session, token hashes, platform/device metadata, absolute expiry and revocation state.
- `mobile_refresh_token_history`: append-only consumed refresh-token hashes used to detect replay.

The history table rejects direct updates and deletes while its owning session exists, while allowing FK-driven cleanup when the owning session/account is deleted. Token values are never persisted.

## Regression coverage

The integration suite covers:
1. Browser cookie authentication in the existing auth integration suite.
2. Mobile registration, email verification, login, invalid credentials and pending accounts.
3. Access-token expiry and rejection of an access token as a refresh credential.
4. Refresh rotation and invalidation of old access/refresh credentials.
5. Parallel refresh replay: only one rotation can succeed and all account mobile sessions are then revoked.
6. Device/platform mismatch and same-device session replacement.
7. Logout current session and logout-all.
8. Password reset and account suspension revocation; account deletion cascade is covered by the schema integration test.
9. Origin-less browser mutation rejection, untrusted Origin rejection and allowed native bearer mutations.
10. Refresh-history immutability and FK cascade cleanup.

## Client implementation

- `src/utils/apiClient.ts` centralizes native API URL handling and bearer transport.
- Refresh credentials are persisted through the Capacitor secure-storage plugin; access tokens remain in memory.
- Refresh is single-flight in the client. Do not run parallel refresh requests: the server deliberately treats reuse as a security event.
- Browser requests continue through the existing cookie transport.
- Google browser sign-in and Paddle checkout are hidden in native builds until native provider sign-in and a store-compliant billing design are ready.


## Verified app links and token safety

- Token-bearing verification and password-reset actions are accepted by the native app only from HTTPS URLs whose hostname exactly matches the build-time `VITE_APP_LINK_HOST`.
- Custom `vow://` links are restricted to the non-secret identity return marker. Account action tokens must never be placed in custom-scheme URLs.
- The existing HTTPS links from `accountActionUrl` remain the email source of truth. Android/iOS open them in the app only after domain association is configured and verified.
- The native build workflow uses repository variable `VOW_APP_LINK_HOST` for the native Android/iOS association and runtime host allowlist. It must match `APP_URL` / `APP_ORIGIN` and contain only a hostname.
- Publish Android `/.well-known/assetlinks.json` with the final application ID and signing-certificate SHA-256 fingerprint, and Apple `/.well-known/apple-app-site-association` with the final Team ID and bundle ID before enabling production app links.
- Didit callback uses `APP_ORIGIN/?identityVerification=return`; the app refreshes Trust Center only when that exact HTTPS host is associated. The custom scheme callback is not trusted to carry verification credentials.
