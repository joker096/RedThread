# Vow Mobile Platform Readiness

Status: architecture audit in progress  
Target platforms: Android and iOS only  
Implementation approach: preserve the existing React UI and evaluate Capacitor; keep the Node.js API and PostgreSQL backend shared.

## Confirmed repository state

- The current `main` baseline is `d57b7fa624871ed8a3e3ed99494701d95f976258`.
- The client is React 19 + TypeScript + Vite.
- The backend is Express + PostgreSQL; it remains the shared service for both mobile platforms.
- No native Android or iOS project is present on this baseline; Capacitor is not installed.
- The current repository still contains a PWA manifest, service worker, install banner, and an Nginx frontend image. These are browser/PWA deployment artifacts, not native mobile projects.
- The README explicitly describes the current product as a prototype, not a production service.
- Existing browser CI/E2E is useful as a regression gate, but it does not replace Android/iOS device testing.

## Mobile-critical findings

### 1. Authentication and API transport — blocking

The current client calls relative paths such as `/api/auth/me` and uses `fetch(..., { credentials: 'include' })`. The API currently authenticates with an HttpOnly `nit_session` cookie configured as `SameSite=Lax`.

State-changing routes use `validateRequestOrigin`, which requires an Origin header matching the single `APP_ORIGIN`. A packaged Capacitor app normally has a different WebView origin (commonly `capacitor://localhost` or an Android app origin), and native HTTP requests may not carry a browser Origin header. Simply adding Capacitor will therefore not make the current session and CSRF model work.

Required design:
- Preserve the existing cookie/Origin/CSRF protections for browser-based development and tests.
- Add a separately authenticated native-client path using short-lived access tokens and rotating refresh tokens.
- Store native refresh credentials only in the iOS Keychain / Android Keystore-backed secure storage; never in localStorage.
- Apply explicit token audience, expiry, revocation, device/session binding, refresh rotation and reuse detection.
- For native bearer-authenticated requests, use a dedicated authentication/CSRF policy; do not weaken cookie-authenticated browser routes.
- Centralize API URL and transport in a typed client instead of scattering relative `fetch('/api/...')` calls.
- Add tests for browser-cookie and native-token paths, including logout, expiry, rotation, replay, account deletion and revoked sessions.

### 2. Native permissions and media — blocking for verification

The API currently sends `Permissions-Policy: camera=(), microphone=(), geolocation=()`. This is safe as a browser default but conflicts with planned native camera/microphone capture if the WebView relies on those browser APIs.

Before changing the policy, map every camera, microphone, photo-library and location use case. Prefer native Capacitor plugins for capture and permission prompts, with server-side upload validation unchanged. Do not grant permissions globally or request them at app launch.

### 3. PWA behavior — remove from the native runtime

`src/main.tsx` registers `/sw.js` in production, and the app includes a PWA install banner and manifest. Native builds must not register the service worker or show browser-install instructions. Keep browser-only artifacts only as development/test tooling until the mobile runtime is validated; do not treat the PWA as an app-store deliverable.

### 4. Authentication providers and deep links

- Google sign-in currently uses browser Google Identity Services. Native builds need the platform sign-in flow and should send the resulting ID token to the existing server-side Google token verifier.
- Email verification and password-reset links currently depend on browser URL query parameters. Native builds need verified HTTPS app links / iOS Universal Links and Android App Links, with safe fallback handling.
- Didit verification callbacks currently use the configured web `APP_ORIGIN`; native return/deep-link behavior must be designed and tested without weakening provider signature checks.

### 5. Billing decision required before iOS release

The repository currently contains Paddle Sandbox integration only. Lady Premium unlocks digital app functionality. Apple App Store payment rules can require StoreKit in-app purchase for digital subscriptions, subject to applicable regional rules and entitlements. Do not silently replace the product's Paddle-only decision. Keep live billing disabled until the iOS distribution/payment approach has been reviewed and approved.

## Deployment target

The mobile app will call a public HTTPS API endpoint. The production VPS deployment should run the API, PostgreSQL, migrations and required background workers behind a TLS reverse proxy. It should not deploy the Vow Nginx frontend or expose a public web product. A public API hostname and TLS certificate will be needed before real-device end-to-end testing; local Android development and CI groundwork can proceed before then.

## Delivery sequence

1. Complete the API/auth/media/provider audit and write native transport/security tests.
2. Add Capacitor to a dedicated feature branch; configure app identifiers, Android/iOS build settings and platform-specific environment handling.
3. Add a typed API transport abstraction and native secure-session implementation without weakening browser protections.
4. Integrate native Google sign-in, camera/photo/microphone flows, deep links and push notifications only with their corresponding tests.
5. Build Android on Windows and validate on emulator/physical Android device.
6. Build iOS using a hosted macOS CI runner; no local Mac is required.
7. Run browser regression CI and mobile platform checks against the same commit SHA. Keep the feature PR Draft until all required checks pass.

## Current scope boundary

- No public Vow website or web product is planned.
- Do not remove or alter existing Draft PRs or merge anything into `main` as part of this mobile foundation work.
- Do not deploy Vow to the VPS until the mobile API contract, public API hostname, TLS, secrets, storage and operational checks are ready.
- The current app is still a prototype; successful packaging alone must not be represented as production readiness.
