# Vow Mobile Camera, Microphone and Verification Media Readiness

Status: native camera/microphone capture is not enabled. The current L3 video-upload path remains gated by the existing server-side consent and storage readiness checks.

## Existing safety controls

- The API sends `Permissions-Policy: camera=(), microphone=(), geolocation=()`; browser media capture is intentionally disabled.
- L3 is not enabled until production private storage, key management, backup and background purge monitoring are ready.
- L3 consent is explicit, versioned and revocable. Upload capabilities are short-lived and bound to the account/session rules.
- Server upload validation checks media format, size and duration and stores media encrypted. Withdrawal queues deletion; account deletion remains blocked until purge is complete.

## Native capture design

- Do not enable `getUserMedia` in the WebView or weaken the global Permissions-Policy to make camera capture work.
- Use a native Capacitor media API only after the L3 storage gate is enabled. The native capture flow must request camera and microphone permission only after the user explicitly starts the L3 recording flow.
- A candidate API is Capacitor Camera 8.1+ `recordVideo`, which returns a native media URI and optional duration/size metadata. Before adopting it, verify front-camera usability, audio recording, maximum duration handling, file URI access and cancellation behavior on real Android/iOS devices.
- Do not upload an unbounded native file or copy a full 100 MB video into memory without testing the memory profile. Prefer a native file-transfer/streaming path if the upload API is adapted for it.
- Define deterministic local temporary-file cleanup after success, failure, cancellation and app termination. Do not save identity videos to the user's photo gallery.
- Preserve the current 30–60 second duration and 100 MB maximum checks on both client and server. The server remains authoritative.
- Keep browser file selection as a development/fallback path; it is not a substitute for native recording validation.

## Other media permissions

- Photo capture should use a native camera picker only in the relevant profile-photo flow and only after an explicit user action.
- Microphone permission must not be requested for voice playback or general app startup. Request it only for a user-started recording flow.
- Location permission is not needed for the mobile foundation. Date Planner location features must use explicit, purpose-specific consent and a manual location fallback.

## Voice introduction purge operations

- The Compose deployment now defines a dedicated `private-voice-intro-purge` service. It runs one bounded PostgreSQL queue batch every 60 seconds and retries failed batches on the next cycle.
- The API and purge worker share the named `private_voice_intros` volume. The encryption key is injected only into the API; the deletion worker never receives it.
- The worker fails closed if the configured storage root is missing or is a symbolic link. It does not treat an unavailable mount as proof that media has already been deleted.
- The queue uses row-level `FOR UPDATE SKIP LOCKED` locking, so multiple worker instances do not process the same queue row concurrently. File deletion is idempotent: an already absent encrypted file allows its stale queue row to be completed.
- This is deployment configuration, not evidence of a running production service. After a real host is provisioned, operators must confirm the named volume is backed up appropriately, start the service, monitor queue age/failures and rehearse restore and deletion before enabling voice introductions.

## Release blockers

- Production private media storage, key lifecycle, backup/restore and purge monitoring.
- A reviewed native file transfer and secure local deletion path.
- Final user-facing permission descriptions for Android and iOS.
- Physical-device tests for front camera, audio, interrupted recording, file cleanup, upload retry and consent withdrawal.
