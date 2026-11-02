# Didit identity verification (Sandbox and Live)

Vow integrates Didit V3 hosted identity verification. The provider API key and signing secret stay server-side. Vow stores only opaque session IDs, provider statuses, timestamps, and the user's consent version; it does not store identity documents, selfies, extracted identity fields, biometric templates, or raw webhook payloads.

## Provider setup

1. Create a dedicated Didit application/workspace for Vow at https://business.didit.me/. Keep Sandbox and Live credentials separate and confirm the selected environment in the console before copying a key.
2. Create one KYC workflow containing **ID Verification, Passive Liveness, Face Match 1:1, and Device & IP Analysis**. Do not add AML, NFC, phone/email verification, age estimation, or other paid modules unless separately approved.
3. Configure a V3 webhook destination for `https://YOUR_VOW_HOST/api/didit/webhook`, subscribe to `status.updated`, and copy that destination's `secret_shared_key` into `DIDIT_WEBHOOK_SECRET`.
4. Copy the selected application's API key, workflow UUID, and application UUID into the server environment. Never expose these values through `VITE_*`, browser code, logs, or support tickets.
5. Use only sample data in Sandbox. Didit states that Sandbox media uploads (documents, selfies and liveness video) are stored by the provider just as Live media is. Never upload real identity documents, real selfies, or personal data to Sandbox.

## Environment configuration

Sandbox is the default and never grants real identity status:

```dotenv
DIDIT_ENVIRONMENT=sandbox
DIDIT_SANDBOX_KEY_CONFIRMED=true
DIDIT_LIVE_KEY_CONFIRMED=false
DIDIT_API_KEY=
DIDIT_WORKFLOW_ID=
DIDIT_APPLICATION_ID=
DIDIT_WEBHOOK_SECRET=
DIDIT_WEBHOOK_SECRET_PREVIOUS=
```

To enable Live, deliberately change to `DIDIT_ENVIRONMENT=live`, set `DIDIT_SANDBOX_KEY_CONFIRMED=false`, and set `DIDIT_LIVE_KEY_CONFIRMED=true` only after verifying the selected Live application and its billing plan. A wrong environment/key pairing must not be treated as a harmless test.

## Free-tier spending guard

Didit currently advertises 500 full KYC verifications per month on its Free tier. Vow enforces a stricter local cap of **500 Live session reservations per UTC calendar month**:

- The cap is checked and reserved atomically in PostgreSQL before any Live session request is sent to Didit.
- At 500 reservations, Vow returns `429 didit_monthly_free_quota_reached` and does not call Didit.
- The aggregate monthly counter contains no user identifiers and survives account deletion, so deleting accounts cannot reset the local cap.
- A provider timeout or ambiguous session-creation failure keeps its reserved slot. This deliberately prefers a lost free slot over accidentally creating a second potentially billable session.
- The cap covers Vow-originated sessions only. Use a dedicated Didit workspace/application for Vow; usage from other apps sharing the same provider quota is not visible to Vow and can consume the same free allowance.

The free allowance and module pricing are provider terms and may change. Verify Billing & Plan in the Didit console before enabling Live. The local cap does not guarantee that Didit will never bill for separately enabled paid modules.

## User flow and consent

- The user must explicitly accept Vow's identity-processing consent (`didit-kyc-v1`) before the server creates a session.
- The consent record stores only the user ID, policy version, environment, and timestamp.
- Vow creates a Didit V3 session server-side with the user's opaque account UUID in `vendor_data`; the browser receives only the hosted verification URL.
- Callback query parameters are not trusted and do not determine verification status.
- A pending or in-review session cannot be recreated by repeatedly clicking the button. This avoids duplicate sessions and duplicate billing.
- A session reservation is made before the provider call. If the provider call times out ambiguously, the reservation remains counted pending manual reconciliation.

## Server-side verdict rules

Vow accepts only a signed V3 `status.updated` webhook for the configured application, environment, workflow, and a session ID already stored against the account.

- Webhook signatures use `X-Signature-V2`: HMAC-SHA256 over recursively key-sorted compact JSON with Unicode preserved. The signed payload timestamp and `X-Timestamp` must match and be within five minutes. Secret-rotation `-Previous` signatures are accepted only with the separately configured previous secret.
- Event IDs are deduplicated in PostgreSQL. Provider event time and the exact current session ID prevent old sessions or out-of-order deliveries from overwriting newer state.
- Sandbox statuses always remain `pending`, including simulated `Approved`.
- In Live, `Declined` becomes `rejected`. `Approved` becomes `verified` only if the signed decision contains non-empty arrays for `id_verifications`, `liveness_checks`, and `face_matches`, and every item in each array has status `Approved`. Missing or incomplete evidence remains `pending`.
- All other statuses remain `pending`.
- No raw webhook payload, document, selfie, extracted identity field, or biometric score is persisted.

## Vow access enforcement

For male accounts, server-side L2 access requires `status=verified` and `provider_environment=live`. Sandbox cannot make a male profile discoverable, cannot allow likes, and cannot allow sending messages. The same rules are checked in direct API routes, not only in the interface. Women are not blocked by this male-specific L2 gate.

**L3 manual verification is a separate release gate and is not implemented by this Didit integration.** Until a reviewed 30–60 second statement, moderator decision, and six-month re-verification process are implemented and tested, do not describe the full three-level Vow verification program as complete or enable production access based on L2 alone.

## Production release checklist

Before enabling Live, verify the current provider plan, country/document coverage, legal basis and privacy notice, data-retention/deletion controls, webhook delivery/reconciliation, account recovery, mobile camera permissions, and end-to-end Live evidence mapping. Test signature failures, duplicate and out-of-order webhooks, old-session events, missing evidence arrays, quota exhaustion, concurrent session requests, and account deletion. A Sandbox approval is not evidence of a real person's identity.
