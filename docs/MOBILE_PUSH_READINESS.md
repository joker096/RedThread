# Vow Mobile Push Notifications Readiness

Status: the remote-push implementation is prepared in Draft PR #435, but delivery remains disabled until provider credentials, native app identifiers and physical-device validation are available. The PostgreSQL in-app notification center remains the source of truth.

## Implemented in the Draft branch

- In-app notifications remain persisted in PostgreSQL and exposed through authenticated API routes.
- Native app-resume refreshes the notification center and trust status.
- Capacitor Push Notifications plugin is integrated for native Android/iOS builds; no permission is requested at app launch.
- A clear opt-in/opt-out control is shown in the native notification center only when the server confirms that the platform provider and token-encryption key are configured.
- Android uses FCM HTTP v1 tokens; iOS uses direct APNs device tokens. The provider-token model is explicit and platform-specific.
- Device tokens are encrypted with AES-256-GCM, fingerprinted with a keyed HMAC, bound to a single mobile session and never stored in plaintext.
- Authenticated registration/status/revocation APIs are available at /api/mobile/push/status and /api/mobile/push-token.
- A database trigger revokes device tokens whenever their mobile session is revoked, covering logout, logout-all, refresh-token reuse, password reset and account-unavailable flows.
- In-app notification creation transactionally queues one generic outbox event per active device token.
- FCM/APNs delivery adapters, bounded retry/backoff, leases, dead-token revocation and one-shot outbox worker are implemented.
- Push payloads contain only generic notification copy and fixed routes. They never contain message text, match IDs, profile names, identity state, addresses or gift details.
- Push taps route to the in-app chats or gifts tab. Details are fetched only after the user opens the authenticated app.
- iOS build setup adds Capacitor APNs AppDelegate callbacks. The aps-environment entitlement is generated only when the Apple Team ID and environment are configured. Android build setup reports when google-services.json is absent.

## Required before enabling delivery

1. Create a Firebase project and Android app matching the final application ID. Supply google-services.json to the protected build environment; never commit it.
2. Create an Apple Developer account/App ID, enable Push Notifications capability, create an APNs authentication key and configure Team ID, Key ID, bundle identifier and provisioning.
3. Generate a dedicated MOBILE_PUSH_TOKEN_ENCRYPTION_KEY with openssl rand -hex 32 and store it in the server secret manager. Do not reuse the identity or photo encryption keys.
4. Supply server-only FCM service-account values and APNs private key values. Never expose these through VITE_ variables or mobile binaries.
5. Schedule server/process-mobile-push-outbox.js at least once per minute and monitor pending/retry/failed outbox counts without logging tokens or payload content.
6. Test token registration/rotation, reinstall, logout, logout-all, password reset, account deletion, permission denial/revocation, FCM/APNs retries, invalid-token cleanup and deep-link routing on physical Android and iOS devices.
7. Verify generic lock-screen copy and foreground/background behavior on supported OS versions. iOS simulator success does not prove APNs delivery.

## External blockers

- Firebase project, Android application ID and protected google-services.json.
- Apple Developer account, final bundle identifier, Team ID, APNs key, signing and provisioning.
- Final production API host and server-side secrets.
- Physical Android and iOS devices for permission and delivery validation.
- A monitored scheduler for the one-shot outbox worker.

Until these exist, the server reports push as unavailable, the app does not request notification permissions, and no false “push enabled” state is shown. In-app notifications continue to work when the app is open or resumed.
