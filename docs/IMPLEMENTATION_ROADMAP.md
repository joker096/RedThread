# Vow implementation roadmap

**Updated:** 2026-10-23  
**Repository:** `joker096/RedThread`  
**Goal:** turn the current prototype and server-backed pieces into a testable release candidate without misrepresenting demo data as live functionality.

## Status legend

- **Existing code:** a component or endpoint is present in the repository.
- **Needs verification:** code exists, but the end-to-end flow has not been confirmed in a deployed environment.
- **Not a release claim:** screenshots, UI badges, seeded data, and passing unit tests alone do not prove a production integration.

## Phase 0 — Baseline and honest product states

Priority: P0 · Do before public promotion

- [x] Document server-backed entry points and demo-only flows.
- [x] Document the ten-scenario screenshot acceptance matrix.
- [x] Make demo/preview mode unmistakable in the UI (persistent prototype disclosure plus separate demo/server discovery labels; continue the trust-label audit below).
- [x] Verify server-backed chat persistence and authorization: integration coverage confirms messages are written/read through the API and blocked/outsider accounts cannot access the conversation. Demo-preview chat remains demo data, not server persistence.
- [ ] Audit all displayed trust labels, compatibility scores, ad counters and “online” indicators; label or remove values that are not backed by live data.
- [x] Keep a single source-of-truth release status page in [RELEASE_STATUS.md](RELEASE_STATUS.md).

**Acceptance:** a tester can tell which data are examples and which came from the API; no screenshot can be mistaken for evidence of real verification, actual revenue, or live conversations.

## Phase 1 — Core account and relationship loop

Priority: P0

- [ ] Run registration, login, session refresh, logout and account deletion against a clean test database.
- [ ] Verify adult-only registration and required consent/legal copy for each launch market.
- [ ] Use two synthetic accounts to test like → reciprocal like → match creation.
- [ ] Verify pass → undo after reload, repeated undo, undo after a match, and profile not reappearing after a like.
- [ ] Verify that blocking removes the blocked profile from discovery and prevents messaging/likes.
- [ ] Verify report submission, moderator access controls, and audit logging.
- [ ] Add scenario-level browser tests for the highest-risk UI paths where the repository's test setup permits it.

**Acceptance:** all expected API status codes and persisted state are asserted; failed requests show actionable UI errors; retries do not create duplicate actions.

## Phase 2 — Safety and moderation

Priority: P0

- [ ] Confirm rate limits, session security, upload validation, image size/type limits, and access controls in a production-like environment.
- [ ] Keep automated text/image screening fail-closed to “pending review” when unavailable or uncertain.
- [ ] Do not automatically punish a user solely on an opaque AI score; preserve human review and audit trail.
- [ ] Add a user-facing explanation of reporting, blocking, appeals and safety limits.
- [ ] Verify account/data deletion behavior, retention policy, backups and moderation/audit retention.
- [ ] Before launch, write abuse-response procedures and identify who reviews urgent reports.

**Acceptance:** security tests pass; moderator routes reject normal users; uncertain AI results do not become silent bans; privacy and escalation procedures are documented.

## Phase 3 — Internationalization and accessibility

Priority: P1

- [ ] Treat English and Russian as initial complete locales; report every other locale's coverage accurately.
- [ ] Add a CI threshold for missing translation keys in the supported launch locales.
- [ ] Add fallback tests for untranslated keys, dates/numbers, plural forms and long translated strings.
- [ ] Test right-to-left layout (Arabic) separately; a locale option alone is not RTL support.
- [ ] Check keyboard navigation, visible focus, screen-reader names, contrast, reduced motion and touch targets on real devices.
- [ ] Remove hard-coded user-facing strings from critical auth, reporting, chat and error paths.

**Acceptance:** declared launch locales have no missing critical strings; unsupported translations use an explicit fallback; key flows remain usable at mobile width and with keyboard/screen reader.

## Phase 4 — Matching quality and user controls

Priority: P1

- [ ] Explain compatibility scores using actual answer fields; avoid presenting a score as scientific certainty.
- [ ] Make dating intention and important preferences visible before a like.
- [ ] Test filters for correct server enforcement, including minimum/maximum age validation.
- [ ] Make undo behavior consistent between server discovery and demo preview; document any plan limits before users take actions.
- [ ] Avoid repetitive profiles while providing a deliberate “review skipped profiles” route.
- [ ] Add snooze/visibility controls only with clear privacy behavior and server persistence.

**Acceptance:** filters and score explanations are consistent across clients; undo does not create duplicate matches; visibility controls have verified server effects.

## Phase 5 — Chat and real-world interaction

Priority: P1/P2

- [ ] Confirm that messages are persisted, authorized per match, and paginated safely.
- [ ] Add send/loading/failed/retry states and test duplicate-send handling.
- [ ] Add safe conversation prompts and a non-intrusive date-planning flow after core chat is reliable.
- [ ] Consider voice/video only after privacy, consent, abuse reporting, and provider costs are evaluated.
- [ ] Add push/email notifications only after opt-in, unsubscribe, localization and delivery configuration are tested.

**Acceptance:** two real test accounts can exchange messages, reload, and see consistent server state; unauthorized users cannot read a conversation.

## Phase 6 — Payments and operational readiness

Priority: P1 before monetized launch

- [ ] **Deferred:** configure Paddle Sandbox in a secret-managed environment; verify checkout, webhook signatures, idempotency, subscription lifecycle and Premium entitlements. Paddle is the only supported payment provider.
- [ ] Confirm product/pricing/renewal/cancellation/refund language and region-specific legal requirements.
- [ ] Test free/trial/paid/expired states with test-mode payments.
- [ ] Configure production database backups, migrations, monitoring, error reporting and restore rehearsal.
- [ ] Configure verified email sending and domain authentication before enabling production email flows.
- [ ] Document deployment, rollback, incident response and secret rotation.

**Acceptance:** payment state is derived from verified server-side events, not client flags; restore and rollback steps are tested; health and error monitoring work.

## Screenshot and preview work plan

The generated image tool is temporarily unavailable, so no concept image is included in this change. Do not substitute hand-authored diagrams or stock images and call them app screenshots.

### Capture real screenshots after the relevant flow passes

1. Onboarding, age gate and registration validation.
2. Discovery card with visible like/pass/undo controls.
3. Filters and “why you match” compatibility details.
4. Undo a pass and confirm the same profile is restored.
5. Mutual match created by two test accounts.
6. Persisted chat with success and failed-send states.
7. Verification status with explicit source and timestamp; omit if no real verification provider is configured.
8. Report and block confirmation.
9. Moderator queue using synthetic data, plus forbidden-access state.
10. Settings with English/Russian, partial locale fallback, theme, mobile and RTL checks.

For every capture record: commit SHA, viewport/device, locale, theme, environment (demo/test/staging), and which API integrations are enabled. Use synthetic profiles only. If a flow is not live, a later conceptual mockup must be labelled **“Concept — not a live screenshot.”**

## Definition of release candidate

Do not call Vow launch-ready until all P0 acceptance criteria are met, critical integration tests run against a disposable test database, a production-like deployment is smoke-tested, no known critical/high security issue is open, and the screenshot set accurately represents the tested build.

## Suggested execution order

1. Finish Phase 0 and baseline CI.
2. Complete Phase 1 core loop and add browser-level tests.
3. Close P0 safety issues in Phase 2.
4. Validate initial locales and accessibility in Phase 3.
5. Capture screenshots only for flows that pass.
6. Complete chat and operational/payment readiness before public monetization.
