# Vow UI scenario audit and screenshot plan

Date: 2026-10-16

## Purpose

Separate real server-backed flows from demo-only UI before capturing product screenshots or claiming release readiness. A visible screen is not proof that its backend flow is configured or production-ready.

## Current evidence from source

### Server-backed entry points visible in the UI

- `ServerDiscoveryPanel` loads registered profiles from the server and has authentication, filter, like/pass history, report, and block state.
- `AccountAccessPanel` contains account sign-in/registration and account deletion UI; end-to-end operation still depends on server configuration and successful integration tests.
- `ModeratorConsolePanel` requests server endpoints for screenings, reports, audit entries, and pending photos; the console is restricted when endpoints return 401/403.
- Billing status is requested from `/api/billing/status`; the UI itself does not prove payment provider setup.
- Registered-profile search is explicitly separated from the demo preview in locale copy.

### Demo/prototype elements that must not be presented as live data

- `src/data/mockProfiles.ts` provides initial example profiles and profile details.
- `App.tsx` seeds chat threads and messages in component state.
- Demo state is persisted in browser localStorage under `nit-demo-state-v1`.
- Several verification, compatibility, ad, and profile-card elements can be shown with sample data. Verify the backing source before describing them as live verification or real analytics.
- Language options include 48 entries counting automatic mode, but the locale selector is not evidence that all 47 language choices are fully translated.

## Screenshot scenario matrix

Status is a planning classification, not a claim that browser/device QA has passed.

| # | Scenario | Source / status | Screenshot acceptance criteria |
|---|---|---|---|
| 1 | Welcome, sign-in and registration | UI exists; live auth needs environment-backed validation | Clear Vow branding, validation/error state, age/consent requirements visible where applicable |
| 2 | Discovery card and swipe | Both server and demo discovery exist | Label demo data clearly; like/pass buttons available without gestures; avoid implying demo profiles are real |
| 3 | Filters and compatibility | UI exists; scores must be explained and data source identified | Show selected filters, compatibility explanation and empty-results state |
| 4 | Undo an accidental pass | Server discovery has action history; demo discovery has local history | Undo restores the correct profile once; no duplicate likes or accidental match |
| 5 | Mutual like / match | Requires two real test accounts for an end-to-end claim; seeded matches are demo | Show both sides' consent and a match created by server state, or label as mockup |
| 6 | Chat and date invitation | Chat UI exists; App seeds local demo conversations | Distinguish local sample messages from persisted messages; show send/error/loading states |
| 7 | Verification / safety status | UI can display demo verification labels; actual verification needs backend/provider proof | Explicitly label sample verification as demo; never claim a real identity check from a static badge |
| 8 | Report and block | Server discovery UI and moderator endpoints exist | Confirm report submit, block behavior, duplicate-submit protection and server persistence |
| 9 | Moderator review | Server-backed endpoints exist; requires authorized moderator account and seeded test cases | Show access denied and populated review states; remove personal/sensitive data from screenshots |
| 10 | Languages, theme and mobile layout | Language selector and responsive styles exist; locale completeness varies | Test English/Russian plus a partial locale and RTL; capture narrow mobile and desktop sizes |

## Capture procedure

1. Start the app with documented local setup and explicitly record whether API/database/auth/billing are configured.
2. Use synthetic test accounts and non-sensitive test data. Never use real users' photos, names, conversations, or moderation records in public screenshots without permission.
3. Capture actual screenshots only from the running app. Record viewport, locale, theme, demo/server mode, and commit SHA.
4. If a flow is unavailable, create a separate conceptual mockup and label it “Concept / not a live screenshot”.
5. Test mobile narrow viewport, desktop, keyboard navigation, focus visibility, reduced motion, loading, empty, success, and failure states.
6. Do not present a test badge as proof of identity verification, demo messages as server persistence, or local ad counters as revenue analytics.

## Next implementation and QA order

1. Finish source inventory and identify API/configuration dependencies.
2. Add/extend scenario-level automated tests for swipe undo, mutual likes, report/block and locale fallback.
3. Fix any discovered defects and wait for CI success.
4. Capture actual screenshots for working flows; create clearly marked conceptual mockups only for missing flows.
5. Publish a release-readiness report with what was tested, what requires credentials, and what remains incomplete.
