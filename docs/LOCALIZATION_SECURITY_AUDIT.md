# Localization and security audit — 2026-10-16

## Scope and status

This is a code-level review of the current feature branch, not a penetration test or legal certification. The app is still a prototype and must not be represented as production-ready.

## Localization findings — current status

- Added `src/i18n/LocaleProvider.tsx`, a persistent locale selector, automatic browser-language detection, locale-aware number/date formatting, and `lang` / `dir` updates on the document.
- The selector lists 48 options, including common world languages and several regional languages. The initial message catalogs provide partial coverage for English, Russian, Spanish, French, German, Portuguese, Italian, Turkish, Georgian, Arabic, Chinese and Hindi. Other listed locales fall back to English; this is a language-selection framework, **not full translation of every screen into every language**.
- Primary navigation and the server-discovery filters/actions have translation keys. Registration, test questionnaires, chat, subscription, moderation, service marketplace, accessibility announcements and email templates still need a complete extraction and translation pass.
- RTL document direction is enabled for Arabic, Hebrew, Persian and Urdu. Layout QA is still required: changing `dir` alone does not guarantee every component works correctly in RTL.
- Country and city are still largely free-text fields. International launch should add canonical country/region data, optional city autocomplete and explicit fallback behavior for unsupported regions.
- User-written bios and messages must remain unchanged; translation of user content should be opt-in and visibly distinguished from the original.

### Localization implementation order

1. Continue extracting hard-coded UI strings to stable translation keys, beginning with registration/authentication, questionnaire, chat, subscription and safety/moderation.
2. Add complete pluralization/number/date rules, locale-aware validation and translated verification/reset email templates.
3. Expand professionally reviewed catalogs by language and region; do not claim a locale is fully supported until missing-key and UI tests pass.
4. Add automated checks for missing/unused keys, screenshots and RTL layouts, long translated strings, keyboard/screen-reader navigation and mobile overflow.
5. Canonicalize country/city search while preserving manual input and Unicode names.
6. Arrange native-speaker review for legal, privacy, safety and payment wording before each regional launch.

## Security review: addressed in this branch

- Mutating API routes that use the Origin validator now reject requests with no Origin header as well as untrusted origins. Browser clients should send the exact configured APP_ORIGIN; verify any non-browser integration explicitly.
- API responses receive baseline headers: X-Content-Type-Options, X-Frame-Options, Referrer-Policy, restrictive Permissions-Policy, and Cache-Control: no-store.
- Profile pass/undo, likes, blocks and reports have in-process rate limits in addition to authentication rate limiting.
- A user can undo their most recent persisted pass. The API only removes the pass belonging to the authenticated user and returns a currently active, visible, opposite-gender profile with confirmed child disclosure.
- No raw message/profile text or text-derived hash is written to the screening metadata table; automated risk flags are for review, not an automatic ban.

## Remaining security / production work

- When PostgreSQL is configured, the auth/profile/report/message limiters use the shared PostgreSQL counter store; fallback/local development paths may still be process-local. Validate multi-instance behavior under production load and configure trusted proxy handling deliberately.
- Email verification and single-use, expiring password-reset tokens are now implemented in code through the Resend API adapter. Configure and test real credentials/domain, delivery and rate limits in each deployment; no real email delivery has been verified in this repository environment.
- Profile photos are uploaded as image bytes, decoded and re-encoded with Sharp, size/pixel limited, stripped of metadata, assigned random names and stored privately. Delivery uses authenticated `/api/photos/<UUID>` references; external HTTPS image URLs are rejected because they bypass sanitization, visibility checks and moderation. Pending photos are hidden from other accounts until approved. An optional free local Ollama vision-model triage is implemented behind `PHOTO_AI_ENABLED=true`; it fails closed to pending review on errors and only makes automatic decisions at a strict confidence threshold. It is disabled by default, requires an installed vision model, and is not an antivirus scanner or a guarantee of safe content. Configure durable private storage, human review and access controls before production.
- Moderator actions for photo approval/rejection and report review are audited in the moderation log; admin endpoints have access-control integration tests. Continue expanding permission tests to every administrative route and define session revocation policy.
- Review all state-changing endpoints for Origin/CSRF enforcement, rate limiting, request size and field validation; add integration tests for missing/untrusted Origin.
- Configure TLS, secure production cookies, database backups/restore drills, dependency vulnerability scanning, secrets scanning, privacy policy, export/deletion workflows and jurisdiction-specific legal review.
- Add external penetration testing before launch. Automated checks and passing CI do not establish security.

## Current behavior to communicate clearly

- Email verification, password reset, phone/identity verification, photo uploads, live payments and real-time messaging are not yet production integrations.
- Local Ollama screening is optional and disabled by default. Without a locally installed model, deterministic local rules are used.
- The 24-hour trial does not create an automatic charge; payment integration is not configured.
