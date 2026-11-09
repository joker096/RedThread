# Vow Product Launch Readiness

Audit date: 2026-11-09  
Product scope: Android and iOS applications only, backed by the Vow API. This document is an engineering readiness record, not a declaration that Vow is ready for production.

## Executive status

Vow has a substantial server-backed foundation and automated CI coverage, but it is **not ready for public launch, live advertising, or live payments**. Several monetization and fulfillment paths are intentionally fail-closed. Do not remove those safeguards by changing environment flags.

The current working mobile branch is `feat/mobile-capacitor-foundation`, PR #429 (Draft). The current `main` base is `d57b7fa624871ed8a3e3ed99494701d95f976258`. No production deployment or merge is authorized by this document.

## Product and platform boundaries

- Ship Vow as Android and iOS apps. The app requires a server API, but this project must not become a public Vow web frontend.
- Existing unrelated websites and services on any future host must remain isolated and unaffected.
- Keep Stripe out of the product.
- Do not enable any payment provider in Live mode without written acceptance of Vow's actual business category and each product being sold.
- Never unlock a paid entitlement from a client redirect, checkout success screen, client event, or unverified request. Only a verified provider event plus server-side reconciliation may grant or revoke an entitlement.
- Never charge an advertiser based only on client-submitted impressions or clicks. A billable event requires a trusted server-issued placement receipt, current campaign approval, consent and contextual eligibility, frequency/fraud checks, and an idempotent ledger entry.

## Feature readiness matrix

| Area | Implemented foundation | Current blocker / release gate |
|---|---|---|
| Mobile sessions | Capacitor Android/iOS foundation, bearer API transport, secure refresh-token storage, rotation, replay detection and revocation | Physical-device testing, final API domain, HTTPS and association files |
| Account lifecycle | Registration, login, email verification, password recovery and account deletion paths | Production email delivery, domain, templates and end-to-end device validation |
| Discovery | Server-backed profile search, filters, likes, passes, blocks and reports | Production data volume, abuse/fraud monitoring and load testing |
| Compatibility | Server-backed relationship assessment; mutual-match endpoint returns Family/Budget/Conflict/Lifestyle scores, difference categories and user-selected non-negotiable conflicts without exposing raw answers | The matrix is available only after both matched users complete the assessment. Gender-specific demo quizzes remain local-only and are hidden in native builds. Scoring is preference alignment, not a prediction of relationship success |
| Chats | Server-backed mutual matches, text messaging, paginated history, in-app notifications, server-enforced 72-hour message window, and coffee/park/dinner/tea quick-invite message templates | Quick-invite controls currently prefill a message; they do not create a structured date plan or independently confirm a venue/time. PR #417 adds the separate two-party date-plan workflow. Remote FCM/APNs delivery and native device validation also remain |
| Trust Center | Didit integration, L2/L3 policy enforcement, moderation queue, consent and media-processing safeguards | Live provider credentials, native L3 capture UX, physical-device tests and moderation staffing. A 15–25 second voice introduction and general voice/video profile capture are not implemented |
| Gifts | Catalog, match-scoped unpaid requests, recipient consent/decline/withdrawal, safety locks and reconciliation records | No payment adapter, protected recipient-address vault, fulfillment provider or delivery-status integration |
| Ads | Explicit consent preferences, campaign approval/eligibility policy, country targeting and event frequency controls | No trusted placement issuance; event ingestion intentionally returns unavailable; no serving, advertiser billing or revenue ledger |
| Lady Premium | Paddle Sandbox checkout, subscription state and webhook-driven entitlement logic | Sandbox only; mobile checkout unavailable; provider and app-store policy blockers described below |
| Partner services | Draft PR #428 adds applications, moderator publication, match-scoped listings and consent-based quote inquiries | PR not merged; partner verification/contracts, marketplace-capable payment settlement, refunds and operations remain |
| Mutual date plans | Draft PR #417 adds two-party confirmation, safety cancellation, privacy-preserving share and notifications | PR not merged; no venue verification, booking, payments or live location |
| Native Google sign-in | Browser Google Identity Services path exists | Native SDK sign-in and server ID-token exchange are not implemented |
| Release operations | Docker/Compose and CI foundations | No production domain/host, secrets, backups/restore rehearsal, monitoring/alerting, incident runbooks or store accounts |

## Native app surface hardening

The current mobile branch now forces native builds onto server-backed discovery, clears legacy prototype state from local storage, disables demo-state persistence, hides prototype/demo navigation and chats, and suppresses local-only quizzes, mock compatibility/safety tools, simulated ad manager surfaces and the Paddle Sandbox paywall. Browser demo mode remains available for development/regression only. The server-backed relationship assessment, profile editor, discovery, inbox, Trust Center, consent preferences and gift-consent flows remain available in the native app.

## Core relationship experience gaps

- The native server chat remains text-only. The server now enforces a 72-hour message window from match creation and the native inbox displays the expiry and disables sending after it. Coffee/park/dinner/tea quick-invite controls prefill safe public-place messages; they are not structured date plans. Voice/video remains separate and unimplemented.
- PR #417 adds a safer mutual-confirmation date-plan flow, but it does not supply the missing 72-hour timer or the original quick-invite actions. Its venue label is user-provided and is not independently verified.
- The server exposes an overall compatibility score and financial-alignment score in discovery. After a mutual match, `/api/matches/:matchId/compatibility` returns a Family/Budget/Conflict/Lifestyle matrix and conflicts with explicitly user-selected non-negotiables. Raw assessment answers are not returned. Both people must complete the assessment; the old local demo modal remains hidden in native builds.
- The gender-specific quiz cards currently calculate results in local React state and include preset completed scores. They are hidden in native builds until backed by account-scoped persistence and server-derived results.
- A 15–25 second voice introduction and native voice/video capture are not implemented. The L3 identity-video workflow is separate and must not be repurposed as a public profile voice/video feature.
- Conversation Coach, Smart Discovery and Relationship Journey remain roadmap items; they must not be presented as shipped capabilities.

## Advertising: current code state

- User consent is stored server-side and defaults to off. The user can withdraw consent; child category preferences are cleared when master consent is withdrawn.
- Campaign approval and eligibility policy exists, including advertiser verification, creative approval, category/context and declared-country checks.
- `server/adEvents.js:isAdEventCollectionEnabled()` deliberately returns `false`. The `POST /api/ads/events` endpoint therefore fails closed with HTTP 503.
- The source explicitly states that no production ad-serving endpoint issues trusted placement receipts. This is an intentional security boundary, not a missing environment variable.
- The demo Ad Manager, estimated revenue, rewarded-ad completion, super-like inventory and boost behavior are not production ad integrations. Native builds must not expose these demo controls.
- No production advertiser billing, spend ledger, invoicing, refund/credit workflow, fraud review or payout reconciliation is ready.

### Required advertising implementation before launch

1. Create a server-owned placement/creative delivery endpoint that evaluates active match/chat/date context and category-specific consent before returning a placement.
2. Issue an opaque, short-lived, one-use placement receipt bound to user, campaign, creative version, placement, context decision and expiry. Do not put sensitive relationship context in advertiser-visible events.
3. Validate receipt and campaign state server-side for impression/click events. Enforce idempotency, viewability rules, caps, fraud checks, advertiser budget and campaign dates.
4. Build an immutable advertiser ledger and reconciliation process. Do not create a payable amount from a raw client event.
5. Build advertiser onboarding, business verification, creative moderation, campaign pause/rejection, invoicing, refunds/credits and support operations.
6. Keep sponsored content clearly labeled. Never rank a sponsored profile as a genuine match or allow advertisers to target sensitive relationship/identity attributes.
7. Rewarded ads may grant inventory only after a trusted ad-network reward receipt is verified server-side. A local callback must never mint super-likes or boosts.

## Payments: critical provider and store-policy blockers

### Paddle account eligibility

Paddle's current Acceptable Use Policy lists these categories as prohibited:
- dating services/applications;
- physical products or products requiring physical delivery;
- advertising services, including sponsorship;
- digital marketplaces that enable third parties to sell products/services.

These categories directly overlap Vow Premium, sponsored placements, physical gifts and the partner-services marketplace. The current integration is Sandbox-only and must remain so. Do not switch `PADDLE_ENVIRONMENT` to Live, create production prices, or send real customer traffic through Paddle unless Paddle gives written approval that explicitly covers Vow and the relevant products.

References:
- https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle
- https://developer.paddle.com/get-started/how-paddle-works/mobile/
- https://www.paddle.com/help/start/account-verification/what-is-domain-verification

Paddle also requires an approved, live HTTPS supplier domain with clear product description, pricing, terms, privacy, refund policy and support details during domain review. Vow currently has no production domain/host configured.

### Apple and Google distribution rules

- Google Play's payments policy explicitly includes dating subscriptions and other digital app functionality among purchases that normally require Google Play Billing, unless the app is enrolled in an applicable regional alternative-billing program.
- Google alternative billing/external-offer programs are market-limited and require enrollment and compliance with their program terms. Do not infer eligibility from device IP or a user-editable country field.
- Apple's external purchase link options require the applicable entitlement and are limited to supported storefront regions. Paddle's mobile guide describes a link-out architecture, but that does not override Paddle's own Acceptable Use Policy or Apple entitlement requirements.
- Therefore, a Paddle-only digital Premium checkout cannot be assumed to work globally in App Store and Google Play distributions. Market-specific external checkout must remain disabled unless the platform program, storefront eligibility and Paddle's written business-category approval are all confirmed.

References:
- https://support.google.com/googleplay/android-developer/answer/9858738
- https://support.google.com/googleplay/android-developer/answer/17161464
- https://support.google.com/googleplay/android-developer/answer/14372887
- https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.storekit.custom-purchase-link.allowed-regions
- https://developer.apple.com/app-store/review/guidelines/
- https://developer.paddle.com/get-started/how-paddle-works/mobile/

### Payment work that remains
**Store billing and advertising-specific policy details**
- Apple App Store Review Guideline 3.1.1 requires IAP for digital features/subscriptions, subject to region-specific external-purchase entitlements; Guideline 3.1.3(e) requires non-IAP payment for physical goods/services consumed outside the app.
- Apple Guideline 3.1.3(g) exempts only apps whose sole purpose is advertiser campaign management. Buying digital ad inventory/boosts to display inside the same consumer app is still an in-app purchase. Keep advertiser campaign purchasing outside the Vow consumer app unless the applicable policy path is confirmed.
- Apple Guideline 4.3(b) specifically calls out dating apps and expects meaningful differentiation. The store submission should explain Vow's serious-relationship focus, verified trust model and mutual-consent date planning, without claiming unfinished capabilities.
- Google Play explicitly lists dating subscriptions as digital subscriptions normally requiring Play Billing; eligible alternative billing/external-offer programs require enrollment and region-specific compliance.


**Premium subscription**
- The current legacy catalog uses `1month`, `3months` and `lifetime`; the UI describes the third option as a one-time payment for access without a time limit. Confirm that this is the intended meaning of the planned 3,990 RUB "unlimited" tier before creating any replacement SKU.
- Select a payment route that is contractually permitted for a dating app and compliant with the App Store / Play Store rules in each launch market.
- Keep entitlement state server-authoritative.
- Complete renewals, grace periods, cancellation, refunds, chargebacks, tax receipts, customer support and reconciliation tests.
- Keep the existing Paddle sandbox integration isolated as a test adapter until provider eligibility is resolved.

**Physical gifts**
- Paddle's AUP excludes physical goods and delivery. Use only a provider/merchant that explicitly accepts physical gift commerce.
- Collect recipient consent before payment and address collection.
- Store delivery addresses in a separately encrypted, access-controlled vault; never expose the address to the sender.
- Add fulfillment, shipment status, cancellation, refund, failed-delivery and provider reconciliation workflows.

**Partner services**
- Paddle's AUP excludes digital marketplaces for third-party sellers and human services. Partner payments need a marketplace-capable provider with explicit approval, partner KYC, split settlement, commission/tax treatment, cancellation and dispute handling.
- Until this exists, PR #428 supports consent-based quote inquiries only; it does not represent a booking or payment system.

**Advertiser payments**
- Paddle's AUP excludes advertising and sponsorship. Select an advertiser billing provider that approves the business model, or use contract/invoice collection outside the consumer app where legally and commercially appropriate.
- Keep advertiser campaign spending separate from consumer Premium entitlements.

## Draft feature branches to audit and integrate

### PR #429 — Capacitor mobile foundation
- Branch: `feat/mobile-capacitor-foundation`
- Draft and open; not merged.
- Current working head after native demo/payment-surface hardening: `6fe24e40c012aba2ee8e0620368b4c230d3909af`.
- Native app now avoids restoring/persisting prototype state and hides demo chat, demo monetization, and unsupported Paddle Sandbox checkout entry points.
- Re-run CI, Browser E2E, Android Debug APK and iOS Simulator build on the exact final head before marking this change checked.

### PR #428 — Partner marketplace
- Branch: `feat/partner-marketplace-mainline-port`
- Draft and open; not merged.
- CI and Browser E2E passed on the branch head checked during this audit.
- Provides partner application/review/publication and consent-based quote inquiries. It does not implement partner payment settlement or booking.

### PR #417 — Mutual date plans
- Branch: `feat/safe-confirmed-date-plan-send`
- Draft and open; not merged.
- CI and Browser E2E passed on the exact branch head checked during this audit.
- Provides mutual-confirmation date plans and safety-driven cancellation. It does not implement venue verification, reservations, payments or live location.

Do not merge these PRs into `main` without explicit approval. Before integration, re-check branch heads, changed files, migrations, PR comments and all CI/E2E runs against the exact current SHAs. There is a concrete migration-prefix collision across the three feature branches: PR #429 adds `212_mobile_sessions.sql`; PR #417 adds `212_mutual_date_plans.sql` through `215_date_plan_safety_gate_cancellation.sql`; PR #428 adds partner migrations `216`–`226`. The migration journal stores full filenames, so identical prefixes do not collide as a primary key, but the numbering/order is ambiguous. For a combined release branch, preserve mobile as `212`, renumber date-plan migrations to `213`–`216`, and partner migrations to `217`–`227`; update all references and verify a clean-database migration run. Also resolve shared `server/index.js`, `App.tsx`, `ServerMatchesPanel.tsx`, notification and translation conflicts before running the full suite again.

## Production infrastructure and release gates

The following are external prerequisites and cannot be completed by code changes alone:

- Final API hostname, DNS, TLS/HTTPS and production environment.
- Android `assetlinks.json` and Apple `apple-app-site-association` using final application IDs and signing certificates.
- Physical Android and iOS device matrix, including cold start, app resume, background/foreground, camera/media, push and deep links.
- Apple Developer and Google Play Console organization/accounts, legal entity and store listing/review.
- Live Didit credentials and approved production configuration.
- FCM/APNs credentials and push token lifecycle.
- Native L3 recording/capture and secure upload UX.
- Production email provider, verified sender domain and delivery monitoring.
- Database backup policy, restore rehearsal, retention jobs, metrics, alerting, log redaction and incident runbooks.
- Legal review of privacy policy, terms, refunds, subscription disclosures, advertising consent, user-generated content moderation and data retention.
- Support workflows for account recovery, payment disputes, identity-verification appeals, abuse reports, gift delivery and partner inquiries.

## Release decision checklist

A release candidate is not ready until all applicable items are checked:

- [ ] Payment provider confirms in writing that it accepts Vow's dating-app business and each intended product.
- [ ] Store billing or approved regional alternative-billing enrollment is complete for each target storefront.
- [ ] Premium, renewals, cancellation, refunds, chargebacks and reconciliation pass sandbox and provider-approved live smoke tests.
- [ ] Ads have a trusted delivery receipt path, consent/context enforcement, advertiser ledger, fraud controls and clear labeling.
- [ ] Gift payment and fulfillment use a provider approved for physical goods; recipient address remains private.
- [ ] Partner verification, contracts, settlement, disputes and refund operations are complete.
- [ ] PR #417 and PR #428 are audited, integrated only after approval, and tested on one exact final SHA.
- [ ] Native Google sign-in, remote push and native L3 capture are implemented and device-tested.
- [ ] Production domain, TLS, association files, secrets, backups, monitoring and support are ready.
- [ ] Signed release builds and store review are complete.
- [ ] No public Vow web frontend is deployed; only the mobile apps and required server API are exposed.

## Current release verdict

**Not production-ready.** The existing security controls correctly keep ad ingestion and Paddle Live payments closed. The next engineering work should complete the native product surface, integrate the two Draft feature branches after audit, and design advertising/gift/partner monetization around providers that explicitly accept those business categories. Payment provider selection is a required product/legal decision, not a flag to flip.
