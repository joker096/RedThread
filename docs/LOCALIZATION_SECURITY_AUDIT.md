# Localization and security audit — 2026-10-16

## Scope and status

This is a code-level review of the current feature branch, not a penetration test or legal certification. The app is still a prototype and must not be represented as production-ready.

## Localization findings

- The active interface is predominantly hard-coded in Russian, including forms, validation messages, profile discovery, moderation notices and empty states.
- Several date/time labels use browser defaults without an explicit locale, so formatting can vary by device language.
- Country and city are free-text values. This is flexible for early testing but will create spelling variants and inconsistent search results across languages.
- No complete translation catalog, in-app language selector, locale persistence, plural rules, or translated email templates exists yet.
- User-entered profile text must remain unchanged; translation should never silently rewrite bios or messages.

### Localization implementation order

1. Introduce a typed locale catalog for Russian, English and Georgian and a single locale provider with persisted preference.
2. Migrate shared navigation, account flow, discovery filters, error/status notices and accessibility labels first.
3. Use explicit Intl.DateTimeFormat and Intl.NumberFormat locale settings.
4. Add locale-aware validation and pluralization; translate emails and legal/privacy text before launch.
5. Replace free-text country/city fields with searchable canonical country data and optional city suggestions, while preserving manual entry.
6. Add tests that render the core account/discovery flows in all supported locales and check for missing keys.

## Security review: addressed in this branch

- Mutating API routes that use the Origin validator now reject requests with no Origin header as well as untrusted origins. Browser clients should send the exact configured APP_ORIGIN; verify any non-browser integration explicitly.
- API responses receive baseline headers: X-Content-Type-Options, X-Frame-Options, Referrer-Policy, restrictive Permissions-Policy, and Cache-Control: no-store.
- Profile pass/undo, likes, blocks and reports have in-process rate limits in addition to authentication rate limiting.
- A user can undo their most recent persisted pass. The API only removes the pass belonging to the authenticated user and returns a currently active, visible, opposite-gender profile with confirmed child disclosure.
- No raw message/profile text or text-derived hash is written to the screening metadata table; automated risk flags are for review, not an automatic ban.

## Remaining security / production work

- The default rate-limit store is process-local. Use a shared store (for example Redis) behind multiple API instances and configure trusted proxy handling deliberately.
- Add email verification and single-use, expiring password-reset tokens. Only send messages through a configured SMTP provider; responses must not reveal whether an email exists.
- Implement safe photo uploads (file-signature validation, size/dimension limits, random names, metadata stripping, malware/vision moderation, private/quarantine storage and controlled delivery). The current API accepts HTTPS photo URLs, not file uploads.
- Add admin/moderator audit logs, session revocation policy, and explicit permission tests for every admin route.
- Review all state-changing endpoints for Origin/CSRF enforcement, rate limiting, request size and field validation; add integration tests for missing/untrusted Origin.
- Configure TLS, secure production cookies, database backups/restore drills, dependency vulnerability scanning, secrets scanning, privacy policy, export/deletion workflows and jurisdiction-specific legal review.
- Add external penetration testing before launch. Automated checks and passing CI do not establish security.

## Current behavior to communicate clearly

- Email verification, password reset, phone/identity verification, photo uploads, live payments and real-time messaging are not yet production integrations.
- Local Ollama screening is optional and disabled by default. Without a locally installed model, deterministic local rules are used.
- The 24-hour trial does not create an automatic charge; payment integration is not configured.
