# Vow Voice Introduction — Physical Device Acceptance Plan

Status: prepared for hands-on execution. No physical-device result is implied by this document.

## Scope and release rule

Run this plan on at least one supported physical Android phone and one physical iPhone using the same identified PR commit and corresponding installable builds. Record device model, OS version, app version/build, commit SHA, test date, tester, and evidence for every case.

Emulator/simulator install, launch, and permission smoke tests do not satisfy these checks. Do not enable Production, public submissions, or a production media key as part of this test.

Use dedicated test accounts and non-sensitive test speech. Do not record identity documents, addresses, health details, or other sensitive personal information.

## Required test setup

- Install the Android Debug APK and iOS development build produced from the exact commit under test.
- Use a dedicated test account with a completed profile and a reachable test API environment.
- Confirm the test environment has a dedicated non-production 32-byte voice encryption key and private storage; never copy production secrets into test logs or artifacts.
- Confirm API and purge worker share the same private media volume.
- Prepare network controls to simulate offline mode and interrupted uploads.
- Enable device logs with tokens, cookies, request bodies, audio bytes, and encryption keys redacted.
- Confirm no recording is uploaded before explicit consent is checked and the user taps the submit action.

## Test matrix

| ID | Scenario | Steps | Expected result |
|---|---|---|---|
| A01 | First-time permission prompt | Open voice introduction; tap Record | Microphone permission is requested only after the tap; no recording before grant |
| A02 | Permission granted | Grant microphone access; record for 20 seconds; stop | Recording stops; preview appears; measured duration is within 15–25 seconds |
| A03 | Permission denied | Deny the prompt | Clear localized explanation; no recording, upload, or crash |
| A04 | Permission denied permanently | Deny and select “don't ask again” / equivalent; tap Record again | App explains how to enable permission in system settings; no repeated prompt loop |
| A05 | Minimum duration boundary | Record just under 15 seconds, then at least 15 seconds | Under-length clip is rejected and local file cleaned; valid clip can be previewed |
| A06 | Maximum duration boundary | Record through 25 seconds | Recording stops automatically at the limit; no clip longer than 25 seconds is accepted |
| A07 | Cancel recording | Start recording; cancel or leave the flow before stopping | Recorder stops; no preview or upload; temporary native file is deleted |
| A08 | Preview and replay | Record a valid clip; listen to preview more than once | Playback is audible and stable; recording is not uploaded merely by previewing |
| A09 | Replace preview | Record a clip; discard it; record another | Previous preview URL and native temporary file are released; only the new preview remains |
| A10 | Explicit consent gate | Prepare a valid preview without checking consent; try to submit | Submission is unavailable or rejected; server stores no recording and no consent grant |
| A11 | Upload success | Check consent and submit a valid clip | One recording is uploaded; UI shows pending moderation; repeated taps do not create duplicate clips |
| A12 | Playback after upload | Fetch the owner's saved recording and play it | Playback works for the owner; private media URL/path is not exposed |
| A13 | Unapproved public access | Request playback as another user while status is pending/rejected | Access is denied; no audio bytes are returned |
| A14 | Approved public access | Approve via moderator workflow; request as an eligible viewer | Playback works only for eligible viewers while consent remains active |
| A15 | Delete and withdraw consent | Delete the saved clip | Profile visibility is removed immediately; consent withdrawal is recorded; purge is queued |
| A16 | Permission revoked in Settings | Grant permission, then revoke it in OS settings and retry | App handles denial safely and does not start native recording |
| A17 | Background during permission prompt | Tap Record and background the app while permission prompt is active | No recording starts after return; no stuck recording state |
| A18 | Background during recording | Record, then switch apps or lock the device | Recording is cancelled; no upload occurs; temporary file is cleaned |
| A19 | Return to foreground | Return after A17/A18 | UI is usable; timer is stopped; user can start a fresh recording |
| A20 | Incoming interruption | Receive a call / audio interruption while recording | Recording stops safely; no corrupted preview or unintended upload |
| A21 | App termination | Force-quit while recording, then relaunch | App does not resume an orphaned recording; stale temporary files are checked and cleaned |
| A22 | Offline upload | Prepare a preview, disable network, submit, then restore network | Clear retryable error; preview remains available; no duplicate upload after retry |
| A23 | Interrupted upload | Interrupt network during upload | No partial clip becomes visible; retry is safe and idempotent |
| A24 | Playback network failure | Start playback, interrupt network | Clear playback error; app remains responsive and can retry |
| A25 | Storage/format validation | Exercise malformed, non-AAC, over-2-MiB and out-of-range test fixtures through the API test harness | Server rejects each invalid fixture independently; no unencrypted media is persisted |
| A26 | Device audio route | Test speaker, wired/Bluetooth headset where available | Preview uses the expected route; app does not unexpectedly start recording on route changes |
| A27 | Locale and layout | Repeat key screens in Russian and English, including narrow device width | Labels, buttons, consent text, and status messages remain readable and tappable |
| A28 | Reinstall/session change | Sign out, sign in as another test account, and repeat playback/delete attempts | No cross-account recording access or stale audio retained in UI |

## Evidence to capture

For each case, record Pass/Fail/Blocked, device and OS, commit SHA, steps actually performed, expected and observed behavior, and a short redacted log excerpt where useful. Screenshots or short screen recordings should avoid showing personal notifications or private account data.

For upload, playback, approval, withdrawal, and purge, correlate the client result with server-side audit/queue records using non-secret recording identifiers. Never attach raw audio, cookies, bearer tokens, session identifiers, or encryption keys to the PR.

## Required sign-off

A platform is not accepted until all applicable cases A01–A28 pass, failures are fixed and rerun on the same candidate commit, and evidence is attached to the PR. Any blocked physical-device case remains an open release gate; simulator success must not be substituted.

- Android device and OS:
- iOS device and OS:
- Tested commit SHA:
- Android result / evidence:
- iOS result / evidence:
- API/moderation/purge result:
- Open defects:
- Tester and date:

## Separate production gates

Passing this device plan does not authorize Production. Before production enablement, separately complete:

1. Dedicated 32-byte encryption-key generation, secret-manager storage, restricted access, backup, restore rehearsal, and rotation/recovery procedure.
2. Persistent private storage with restrictive ownership/permissions and a verified backup/restore policy.
3. API and purge-worker shared-volume verification; alerting for worker exits, repeated failures, oldest queue age, and queue growth.
4. Staffed moderation ownership, access review, response-time target, and escalation procedure.
5. A deletion drill proving withdrawal immediately hides the recording and the encrypted object is eventually purged.
6. Legal/privacy review of consent wording, retention, moderator access, and user deletion rights.
