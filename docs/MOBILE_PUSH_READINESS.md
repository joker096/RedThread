# Vow Mobile Push Notifications Readiness

Status: remote push delivery is not enabled. The existing in-app notification center remains the source of truth.

## Implemented

- Server-side in-app notifications are persisted in PostgreSQL and exposed through authenticated API routes.
- The native app now emits an app-resume event. The notification center refreshes unread counts and notification rows when Android/iOS returns to the foreground.
- Trust Center status also refreshes on app resume and after a verified identity return.
- No push permission is requested at app launch or silently.

## Required before implementing remote push

1. Create a Firebase project for Android and configure FCM. Keep `google-services.json` out of Git; deliver it through a protected build secret/artifact or an encrypted repository secret workflow.
2. Create the Apple Push Notifications authentication key and configure the final Apple Team ID, bundle identifier and signing profile.
3. Decide whether iOS will use direct APNs tokens or FCM for both platforms. Use one documented provider-token model.
4. Add a device-token registry bound to a mobile session, with encrypted token storage, token rotation, logout revocation and account-deletion cleanup. Never store provider tokens in plaintext.
5. Add an authenticated registration API, provider delivery worker, retry/backoff, dead-token cleanup and delivery audit records that do not store message content.
6. Add a clear opt-in control in Notification Settings. Ask permission only after the user enables notifications; handle denied/revoked permissions and OS settings changes.
7. Use privacy-safe notification payloads. Do not put message bodies, match identities, sensitive verification state, addresses or gift details in lock-screen payloads. Fetch details only after app authentication.
8. Test token rotation, reinstall, logout, logout-all, account deletion, disabled permissions, delivery retries, duplicate provider callbacks and deep-link routing on physical devices.

## External blockers

- Firebase project and Android FCM configuration.
- Apple Developer account, APNs key, Team ID, signing and provisioning.
- Final application identifier and production API host.
- Physical Android and iOS devices for permission and delivery validation.

Until those exist, do not request notification permissions and do not display a false “push enabled” state. In-app notifications continue to work when the app is open or resumed.
