# Vow release status

**Last reviewed:** 2026-10-17  
**Repository:** [joker096/RedThread](https://github.com/joker096/RedThread)  
**Current status:** **Development preview — not release-ready**

This page is the single source of truth for implementation status. A merged PR or passing CI is evidence for the checks it actually runs; it is not proof of a deployed production service, real-device usability, moderation operations, or legal readiness.

## Verified in repository / CI

- [x] Server-backed registration, login, session lookup and logout have integration coverage.
- [x] Like, reciprocal like, match creation, pass and undo flows have integration coverage.
- [x] Block/report flows have integration coverage; blocking removes mutual likes and blocks access to the affected conversation.
- [x] Chat endpoints enforce match-participant authorization; outsider read/send attempts are tested in [PR #8](https://github.com/joker096/RedThread/pull/8).
- [x] Discovery motion and mutual-match celebration are merged in [PR #9](https://github.com/joker096/RedThread/pull/9).
- [x] CI passed for the PR #9 head: [run 38964426218](https://github.com/joker096/RedThread/actions/runs/38964426218).
- [x] CI passed on main before the latest merge: [run 38964444843](https://github.com/joker096/RedThread/actions/runs/38964444843).
- [ ] Keyboard dismissal, focus trapping and focus restoration for the match dialog are awaiting CI/review in [PR #10](https://github.com/joker096/RedThread/pull/10).

## Must be completed before public launch

- [ ] Finish and verify the P0 acceptance criteria in [the implementation roadmap](IMPLEMENTATION_ROADMAP.md).
- [ ] Make demo/preview data unmistakable and audit every trust, verification, compatibility, online and advertising metric for a real source.
- [ ] Validate registration, adult-only gating, consent/legal copy and account deletion against a clean disposable database.
- [ ] Complete browser-level, two-account end-to-end scenarios, including reload and failure/retry cases.
- [ ] Verify production-like rate limiting, session/cookie settings, upload limits, moderation access and audit logging.
- [ ] Document privacy/data retention, appeals and urgent-report response ownership.
- [ ] Test keyboard/screen reader, reduced motion, contrast, mobile touch targets, long translations and RTL layout on actual devices.
- [ ] Verify deployed staging/production configuration, database backup/restore, monitoring, rollback and secret rotation.
- [ ] Capture real screenshots only from a tested build; label concept previews clearly.

## What is not claimed

- No claim that Vow is deployed or publicly available.
- No claim that real users, live moderation staff, identity verification, payments, ad billing, push delivery or online-presence infrastructure are operational unless a configured integration is separately verified.
- No claim of production readiness based on CI alone.

## Release decision

**Do not promote as launch-ready** until every P0 acceptance criterion is checked, the critical end-to-end suite passes against a disposable test database, and a production-like deployment is smoke-tested.
