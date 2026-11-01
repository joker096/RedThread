# Sumsub identity verification (sandbox)

Vow uses Sumsub as its identity-document and liveness provider. The integration is deliberately sandbox-only until the provider account, legal basis, privacy notice, retention settings, and production credentials have been reviewed.

## Dashboard setup

1. Create a **Sandbox** App Token and API Secret Key in the Sumsub Dashboard.
2. Create a WebSDK 2.0 verification level named exactly as `SUMSUB_LEVEL_NAME` (default: `vow-l2-document-liveness`). Configure the required identity-document and liveness/video steps in Sumsub; the level name alone does not configure those checks.
3. In WebSDK settings, allow the exact HTTPS origin hosting Vow.
4. Create an HTTPS webhook pointing to `https://YOUR_VOW_HOST/api/sumsub/webhook`.
5. Subscribe to `applicantReviewed` and select `HMAC_SHA256_HEX`. Copy the webhook's separate signing secret into `SUMSUB_WEBHOOK_SECRET`.
6. Configure the server environment variables below. Never expose these values through `VITE_*`, client code, logs, or support tickets.

```dotenv
SUMSUB_ENVIRONMENT=sandbox
SUMSUB_APP_TOKEN=
SUMSUB_SECRET_KEY=
SUMSUB_WEBHOOK_SECRET=
SUMSUB_LEVEL_NAME=vow-l2-document-liveness
```

## Runtime flow

- An authenticated user starts verification from the Trust Center.
- Vow sends a stable opaque account UUID to Sumsub as `userId` and requests a short-lived (10-minute) WebSDK access token server-side.
- The browser receives only the temporary SDK token. The App Token and API Secret Key remain server-side.
- Sumsub returns decisions through the signed webhook. Vow validates the HMAC against the exact raw request bytes and accepts only completed `applicantReviewed` events for the configured level.
- Only a completed `GREEN` decision becomes `verified`; a completed `RED` decision becomes `rejected`. Browser callbacks and user-submitted values cannot grant a badge.
- Vow stores only the Sumsub applicant identifier, configured level, decision, and provider event time. Identity documents, selfies, video, and biometric templates are not copied into Vow's database.

## Before production

Do not change `SUMSUB_ENVIRONMENT` to production in this integration. Production requires a separate deployment review: production credentials and API base URL, Sumsub approval, verified webhook delivery, legal/privacy disclosures and lawful basis, data-retention/deletion alignment, incident handling, account recovery, mobile WebView camera permissions, and end-to-end tests using Sumsub's approved production setup.

A successful build or sandbox callback does not prove that the Sumsub level is correctly configured or that production verification is available.
