# Didit identity verification (sandbox only)

Vow uses Didit V3 hosted verification sessions. The current adapter is deliberately **sandbox-only**. Sandbox sessions use mocked checks and must never be treated as real identity verification or grant a trust badge or access permission.

## Didit setup

1. Create a Didit account and a separate **Sandbox** application at https://business.didit.me/.
2. Create a KYC workflow for Vow. For a free-tier candidate, select only ID Verification, Passive Liveness, Face Match 1:1 and Device & IP Analysis. Do not enable AML, active liveness, NFC, phone/email verification, white-label/custom branding, age estimation or other paid modules.
3. Confirm the current Billing & Plan page for the organization before activation. Didit's help centre announced a monthly credit-model change for 1 November 2026; do not rely on historical free-tier wording or assume over-quota usage is blocked automatically.
4. Copy the workflow UUID and application UUID from the Didit console.
5. Add an HTTPS webhook destination for `https://YOUR_VOW_HOST/api/didit/webhook`, version `v3`, subscribed event `status.updated`. Save the destination's `secret_shared_key` as `DIDIT_WEBHOOK_SECRET`.
6. Add the sandbox API key and identifiers to the server environment below. Never expose these values through `VITE_*`, client code, logs or support tickets.

```dotenv
DIDIT_ENVIRONMENT=sandbox
DIDIT_API_KEY=
DIDIT_WORKFLOW_ID=
DIDIT_APPLICATION_ID=
DIDIT_WEBHOOK_SECRET=
DIDIT_WEBHOOK_SECRET_PREVIOUS=
```

## Runtime flow

- An authenticated Vow user starts verification from the Trust Center.
- Vow creates a Didit V3 session server-side with the user's opaque account UUID in `vendor_data`; the browser receives only the hosted verification URL.
- The user is redirected to Didit's hosted page. Callback query parameters are not trusted and do not determine verification status.
- Vow accepts only a signed V3 `status.updated` webhook for the configured application, sandbox environment, workflow and a session ID already stored against the account.
- Webhook signatures use `X-Signature-V2`: HMAC-SHA256 over recursively key-sorted compact JSON with Unicode preserved. The signed payload timestamp and `X-Timestamp` must match and be within five minutes. Secret-rotation `-Previous` signatures are accepted only with the separately configured previous secret.
- Event IDs are deduplicated in PostgreSQL and provider event time prevents older deliveries from overwriting newer state.
- **Sandbox `Approved` is recorded only as a provider test result. It remains `pending` in Vow and never grants a verified badge or protected access.** No raw webhook payload, document, selfie, extracted identity field or biometric score is persisted.

## Production release gate

Do not set `DIDIT_ENVIRONMENT=live`: the current adapter rejects Live credentials by design. Before production, separately review Didit's current pricing and credit eligibility, paid-module exclusions, country/document coverage, legal basis and privacy notice, retention/deletion controls, webhook reconciliation and retries, account recovery, manual-review handling, mobile camera permissions, and end-to-end tests with an approved Live application. A sandbox approval is not evidence of a real person's identity.
