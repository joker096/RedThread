# Vow contextual advertising, partner offers, and revenue policy

Status: design specification, not a production implementation. This document separates when an offer may be shown, how advertisers are charged, and how Vow collects its own subscription revenue.

## Product principle

Advertising follows a useful, user-confirmed relationship milestone. It must never interrupt discovery or exploit private conversation. A paid campaign cannot bypass eligibility rules. The server denies by default; each campaign has a category, audience, trigger, frequency cap, expiry, geography, billing model, landing page, moderation status and budget.

Never show ads in profile discovery, likes, match formation, compatibility questions, private chat, voice/video calls, safety flows, reporting/blocking, account verification or payment/checkout screens. Advertisers never get user identities, contact details, chat contents, compatibility answers, exact meeting locations or access to private events.

## Milestone gates

### Cafes, restaurants, coffee shops, parks and first-date experiences

**Only after both people agree to a date.**

- An invite must be explicitly accepted and the pair must have a confirmed date record. A sent/unaccepted/rejected/cancelled invite, a match alone, a chat timer or one person's interest is insufficient.
- Show a small, dismissible “Ideas for your date” area outside private chat, for example on the confirmed-date detail screen, only if both users have ad consent and the campaign is approved for that region and category.
- Offers can be available to both people, separately. Do not reveal either person's location or exact venue choice to advertisers. Use only a broad area/city that a user has independently chosen to share.
- If the meeting is cancelled, hide offers linked to that meeting. Never pressure users to attend, spend or reveal a location.
- Clearly label paid placements “Реклама” / “Sponsored”, state discount restrictions and expiry, and do not imply a venue is booked or endorsed by Vow unless a real booking integration confirms it.

### Flowers, gifts, books and experiences

- Use the same confirmed mutual-date gate, unless a user explicitly opens gift discovery themselves.
- Do not infer budget, income, religion, health or vulnerability; do not suggest expensive gifts as proof of affection.
- Never tell a user that their match browsed, clicked or bought something.

### Women's clothing, beauty and bridal services

**Bridal offers must never be shown to men.** Use the viewer's explicit self-described profile setting, never a prediction.

Ordinary fashion/beauty offers require category opt-in. Bridal dresses, wedding makeup/hair, bridal salons and wedding planners require every condition below:
1. Viewer self-identifies as a woman in profile settings and meets the product's age policy.
2. Viewer explicitly opted into wedding-planning offers using a separate, revocable toggle.
3. The match is at least 14 days old.
4. Both people were active in that match on at least 3 distinct days.
5. Each person sent at least 20 messages in that conversation; count messages only, never inspect/classify their content.
6. Viewer explicitly selected a serious relationship/marriage-planning interest in a dedicated optional setting.
7. Consent, region, safety, moderation, frequency and campaign-expiry checks all pass.

These are conservative starting defaults, configurable by Vow policy but never weakened by advertisers. They are not proof the couple plans to marry. Do not expose eligibility signals or partner identity to advertisers. Do not infer pregnancy, fertility, religion or sexual orientation. If the match is blocked, reported, paused or safety-restricted, suppress all match-contextual offers.

### Other advertiser categories

| Category | Minimum gate | Default audience |
| --- | --- | --- |
| Cafes/restaurants/date venues | Mutually accepted, confirmed date | Both people, separately, with consent |
| Flowers/gifts/experiences | Confirmed date or user-requested discovery | Opted-in user(s) |
| Women's fashion/beauty, non-bridal | Category opt-in | Women who opted in |
| Bridal wear/wedding vendors | Full bridal gate above | Opted-in women only |
| Wedding photographers/venues/hosts | Full bridal gate | Opted-in women by default |
| Legal/family-law services | User opens legal help or opts in | Requesting user only |
| Travel/weekend activities | User-selected region and category opt-in | Opted-in users |
| General local business offers | Category opt-in and broad geography | Eligible opted-in users |
| Health, supplements, finance/credit, gambling, alcohol, tobacco, adult services, political/religious campaigns | Blocked pending separate policy/legal review; high-risk categories remain prohibited | No targeting by sensitive traits |

Advertisers may narrow eligibility or add stricter rules, never weaken platform minimums.

## Consent, privacy and safety

- Separate controls for contextual ads, wedding offers and partner communications. Consent is optional, granular, revocable and never bundled with account creation, matching, safety or Premium.
- Persist the current consent state separately from an append-only choice history. Write the normalized preference snapshot and current state in one database transaction; if history recording fails, roll back the preference change. Do not collect IP addresses, user-agent strings, chat data or inferred traits in the history. Delete user-linked history when the account is deleted, subject to applicable retention requirements.
- The authenticated ad-event endpoint rejects impressions/clicks unless an explicit persisted master ad-consent opt-in exists. Revocation and event writes serialize on the consent row; missing consent defaults to off. These minimal events are for frequency control and are not proof of billable impressions.
- Ad-event records have a 90-day cleanup policy implemented by `npm run ads:cleanup-events`; the script is a one-shot job, not an automatically scheduled worker. Deployment must configure and monitor a daily scheduler before production, alert on failures, and verify deletion behavior. Do not claim the retention policy is active until that scheduler is installed.
- Event UUID idempotency is bounded by event retention: after an event row is deleted, a replayed UUID is no longer recognized as a duplicate. Clients must generate fresh UUIDs for new events; the endpoint must not be used as a billing ledger. If permanent billing idempotency is later needed, store billing records separately with their own retention and immutable reconciliation trail.
- Include “Why am I seeing this?”, “Hide this offer”, category controls and report-ad actions.
- Eligibility uses minimal derived metadata only: confirmed-date state, match age, active-day count, per-side message counts, opt-in flags and safety state. Never copy message bodies, voice transcripts, photos, compatibility answers or contact information into ad targeting.
- Do not send user IDs, pair IDs, gender, conversation counts, exact dates, location or eligibility reasons to advertisers. Reports are aggregate, with small-cell suppression.
- Ad clicks/redemptions never affect compatibility ranking or profile visibility. Advertisers cannot pay to boost matching.
- Apply per-user frequency caps, budgets, expiry, region/age eligibility, advertiser verification, creative and landing-page review, discount terms and a campaign kill switch.
- A safety restriction, block, report, account deletion, opt-out or campaign pause suppresses delivery immediately. Dismissing an ad must not reduce product functionality.
- Ban dark patterns, fake countdowns, unverifiable discount claims, misleading “verified by Vow” badges and claims that purchases improve relationship success.

## Event and eligibility model

Suggested server-side states: date invite sent → accepted → confirmed → cancelled/completed. Bridal eligibility is computed at request time from match creation time, distinct active days, per-side message counts, explicit opt-ins, self-described profile settings and safety state. Never store a permanent inferred “marriage intent”.

Use category allowlists and a rules version. If required data is missing, stale, contradictory or the eligibility service fails, return no ad. Log minimal eligible/impression/click/dismiss/report/redemption events with idempotency keys and bounded retention. An impression is billable only under a contractually agreed viewability definition and fraud checks, not merely because an API returned an ad.

Test both allow and deny cases: unaccepted/cancelled date, one-sided conversation, insufficient duration/counts, wrong audience, missing consent, blocked/reported pair, expired campaign, region mismatch, frequency cap and eligibility-service failure.

## Advertiser commercial model (Vow revenue)

Start with auditable products and avoid promising reach before traffic exists:
1. **Founding local partner:** fixed monthly sponsorship in one city/category, limited placements and a defined impression cap.
2. **CPM:** price per 1,000 verified viewable impressions only after viewability measurement and invalid-traffic filtering exist.
3. **CPC:** charge for deduplicated valid clicks, with bot/fraud exclusions and a defined attribution window.
4. **Redemption/qualified lead:** a later option only when users intentionally request a coupon or contact; define exactly what is billable and obtain consent.
5. **Sponsored discount:** advertiser funds the discount; Vow's advertising fee is separate. Coupon face value is not Vow revenue.

Each insertion order defines net price, currency, tax treatment, dates, audience gates, category, geography, caps, billing metric, invalid-traffic policy, cancellation/refund terms, creative approval, reporting and discount funding. Report gross billed, tax, refunds/credits, payment fees and net receipts separately. Never guarantee outcomes or sell personal data.

### How advertisers pay

Do **not** assume Paddle is suitable for third-party businesses buying ad inventory. Paddle's documented product is focused on software/digital-product billing; confirm with Paddle and legal/accounting whether advertising inventory is eligible before using it for ad spend. Until confirmed, use approved B2B invoices/bank transfer or a separately reviewed business-payment provider, reconcile payments, and activate campaigns only after payment and order details are verified. Do not mix campaign spend with consumer Premium checkout or activate a campaign on a webhook alone without checking order, amount, currency, status and contract.

Do not build advertiser payouts to venues/affiliates into the first release. In the initial model, Vow sells ad inventory and the advertiser funds its own coupon. Revenue-sharing requires separate contracts, accounting, fraud controls and a reviewed payout provider.

## Paddle: Vow's own Premium revenue

Paddle is already wired in this repository for Vow Premium using Sandbox-only configuration. Keep it separate from advertiser billing until Paddle confirms ad-inventory eligibility.

- Preserve server-created checkout transactions, server-controlled price IDs and user ID custom data, raw-body signature verification, idempotent webhook processing and database-driven entitlements.
- Never accept client-supplied amount, price ID, user ID, entitlement, discount or checkout redirect as proof of payment.
- Reconcile verified transaction and subscription lifecycle events with stored Paddle IDs and expected product/price IDs. Preserve idempotency and stale-event protection. Implement and test refunds/adjustments and subscription cancellation semantics before live mode.
- Premium activation/cancellation must not silently opt a user into ads or wedding offers. Premium and ad consent are independent.
- Build an internal finance ledger/report with Paddle transaction ID, plan/price, gross amount, currency, tax, fees, refund/adjustment, net payout, event time and reconciliation status. Use actual Paddle transaction/payout data and the current commercial agreement; never guess fees.
- Keep advertiser campaign spend, advertiser invoices, coupons and Premium subscriptions in separate order types, accounting codes, permissions, reports and refund paths.
- Sandbox remains mandatory until duplicate/out-of-order webhooks, declines, renewals, cancellations, refunds and entitlement revocation are verified. Never commit or expose live credentials in the browser or repository.

Official references:
- [Paddle webhooks and lifecycle events](https://developer.paddle.com/webhooks/)
- [Paddle integration options and sandbox](https://www.paddle.com/billing/integration)
- [Paddle one-time subscription charges](https://developer.paddle.com/build/subscriptions/bill-add-one-time-charge/)

## Rollout sequence

1. Approve this policy and advertiser terms; review advertising, privacy, consumer and tax obligations in each launch country.
2. Implement and test server-side eligibility without delivering ads.
3. Consent storage, authenticated API (`GET /api/ads/consent`, full-replacement `PUT /api/ads/consent`) and user-facing settings controls are implemented; verify cross-account isolation, persisted revocation, mobile accessibility and localization.
4. Run internal campaigns with no billing.
5. Pilot confirmed-date cafe offers in one city with fixed sponsorship and manual invoicing.
6. Add impression/click billing only after measurement, reporting, anti-fraud and refunds are tested.
7. Add bridal campaigns only after opt-in, thresholds, suppression and audience tests pass.
8. Keep Premium Paddle Sandbox testing and advertiser billing independently gated; enable production only after formal review.

This document defines intended policy. Consent storage/API, user-facing consent settings and a pure eligibility helper exist. Trusted date/safety data integration, live ad serving, advertiser invoicing and production Paddle billing remain unimplemented. The API must continue to fail closed until eligibility receives trusted server-side facts.


### Engagement events are not billable evidence

The authenticated `/api/ads/events` endpoint currently records consent-gated, client-reported engagement for frequency control and idempotency only. A stored `impression` or `click` row is **not** proof that an ad was actually viewable, that the campaign was approved and active at display time, that traffic was valid, or that attribution rules were satisfied. The pure `evaluateAdEventBillingEligibility()` guard requires all those facts plus a trusted server-measurement proof source; it is not connected to billing. Never use client event counts directly to invoice advertisers. Before billing, implement signed/server-issued display authorization, server-verifiable viewability/attribution, invalid-traffic controls, campaign registry checks, audit/reconciliation, and tests for replay and fabricated events. Until then, advertiser billing remains disabled.


### Consent policy versioning

Persisted consent is valid only when its `consent_version` matches the current server-side `AD_CONSENT_VERSION`. The consent read serializer and engagement-event endpoint both fail closed for missing or stale versions. When the policy changes in a material way, increment the version; existing users will then see consent as off until they make a fresh explicit choice. The consent update API writes the current version and appends the normalized choice to the history table in the same transaction. Do not use a client-supplied version as authority.


### Engagement-event rate limits

The current authenticated event endpoint applies a server-side cap of 3 impression events and 5 click events per user per campaign in a rolling 24-hour window. Event IDs and the per-user/campaign advisory lock serialize concurrent attempts so parallel requests cannot simply race past the counters. The click cap limits event spam; it does not prove a genuine human click, viewability, attribution, or billable engagement. The endpoint remains an anti-abuse/frequency-control mechanism only.

## Release blockers — must be implemented before enabling ads

The current event endpoint is a consented, frequency-limited event collector only. It is **not** an ad-serving authorization system or a billing ledger. Do not enable campaigns or bill advertisers until all of these server-side controls are shipped and tested:

1. **Approved campaign registry:** a server-owned `ad_campaigns` registry and event-ingestion checks for advertiser verification, campaign status, creative approval/version, category, allowed countries and start/end times are implemented. Before launch, extend and verify the registry workflow for campaign budget enforcement and landing-page review, and ensure creative revocation is reflected in the server-owned approval fields. A syntactically valid client-supplied ID is never evidence that a campaign exists or is approved.
2. **Serving authorization:** implement a separate server-side eligibility decision using the current viewer consent, category preferences, region, date/milestone state and safety restrictions. The event endpoint must not be treated as a way to make an otherwise ineligible offer eligible.
3. **Independent measurement proof:** client-submitted impressions/clicks are analytics signals only. Billing requires trusted server-side viewability and attribution evidence, invalid-traffic screening, deduplication and auditable budget accounting. Never derive a charge solely from `ad_events`.
4. **Operational retention:** deploy and monitor the documented daily 90-day cleanup job; alert on missed runs and verify actual deletion.
5. **Launch review:** security, privacy, moderation, legal and billing owners must sign off before production serving or charging is enabled.

## Gift-delivery release blockers

The gift creation policy helper is a pure eligibility check; it does not create an order or enforce limits atomically. The sender request limit (3 per 30 days) and recipient acceptance limit (1 per 7 days) must be checked against trusted database rows inside a transaction serialized by deterministic pair, sender and recipient locks. Add concurrent integration tests proving parallel requests cannot exceed either limit. Until an order-creation endpoint, transactional limits, encrypted recipient-address vault, payment authorization/void/refund reconciliation, and vetted courier handoff exist, keep order creation, payment and dispatch disabled. Never expose recipient address or live courier location to the sender.

