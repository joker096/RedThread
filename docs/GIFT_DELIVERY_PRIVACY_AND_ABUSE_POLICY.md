# Vow gifts and privacy-preserving delivery policy

Status: policy, fail-closed decision helpers, PostgreSQL order/catalog/partner schema, recipient gift-request preference API, privacy-safe order-list API, and recipient-only accept/decline endpoint are implemented. The preference UI exists; the recipient decision UI, order creation API, encrypted address vault, payment authorization, courier integration, and dispatch are not implemented or enabled.

## Product flow
Vow may list approved flowers, sealed chocolates/confectionery, books, and other reviewed non-cash gifts delivered by vetted local partners. Sender chooses an item and starts a **pending request**, not an authorized shipment. Recipient must accept that specific gift before any address is collected or shared.

1. Sender sees catalog, total price, delivery fee, availability and estimate for the recipient's delivery area. Do not reveal or confirm private city, address, phone, email or coordinates. A sender must never be asked to obtain the address directly.
2. Create an expiring request with an opaque order reference. No arbitrary attachments. Optional note is short, moderated and rejects links, contact details, payment requests and off-platform solicitation.
3. Recipient sees item, sender identity as already visible in Vow, note, price and delivery expectations. They can Accept, Decline, Report or Block. Silence is not consent. Decline/expiry is neutral; do not tell sender why.
4. Only after acceptance, recipient enters and verifies delivery details in a secure Vow flow. The address is never exposed to sender, analytics, ad events, URLs, push notifications or routine support screens.
5. Send only minimum necessary address/contact/delivery data to the vetted carrier via authenticated server-to-server API. Carrier receives no chat, match history, compatibility, gender or ad identifiers. Sender sees only generic status: accepted, preparing, dispatched, delivered, or delivery failed.
6. Delete/redact address after the delivery, dispute and legally required retention window. Financial records, if required, are retained separately. Provider webhooks must be signed, idempotent, replay-protected and checked against stored order, amount, currency and allowed state.

## Server-side eligibility gates
- Both accounts active and adult; sender verified; both safety states explicitly safe.
- Active mutual match at least 3 days old, both sides sent at least 3 messages (counts only; never inspect message content).
- Recipient explicitly enabled gift requests; consent is separate from ad consent, Premium and match status.
- No block, report, pause or unknown safety state. Facts come from trusted server records only.
- Recipient acceptance, block creation and report submission share a deterministic per-pair PostgreSQL advisory lock. Acceptance re-reads match/account/block/report state after acquiring the lock and takes a shared lock on an existing gift-preference row, so a concurrent opt-out on that row is serialized. Missing preference rows remain disabled. Blocking or reporting atomically changes only `awaiting_recipient_consent` requests to `blocked` or `reported` and appends an audit event; accepted or in-flight orders are not silently rewritten and must pass a fresh safety check before any future fulfilment. This is a partial concurrency safeguard, not a substitute for PostgreSQL integration tests covering account deletion/restriction, moderation transitions, and all future safety mutation paths; every new pair-level safety mutation must use the same lock protocol.
- At most one pending request per pair, 3 new requests per sender per 30 days, and at most one accepted gift to a recipient per 7 days. Add global/device/payment velocity checks and manual review for suspicious patterns.
- Strict catalog allowlist, verified supplier, approved creative/item, transparent price/currency/taxes/delivery/refund terms, and confirmed provider coverage for recipient's region.
- Recipient consent is per order, revocable before dispatch where feasible, never inferred or preselected. Sender payment must not be captured before acceptance unless a reviewed processor supports a clearly disclosed reversible authorization.

## State machine
`awaiting_recipient_consent → recipient_accepted → address_verified → fulfilment_authorized → dispatched → delivered`

Exception/terminal states: `declined`, `expired`, `cancelled`, `blocked`, `reported`, `delivery_failed`, `refund_pending`, `refunded`.

The pure `canTransitionGiftOrder` helper now checks both legal state edges and the actor allowed to perform them: recipient-only consent/decline, system-only expiry and fulfilment authorization, `delivery_partner` for dispatch/delivery/failure, and `payment_service` for final refund state. The helper deliberately excludes a `draft` state because the current PostgreSQL status constraint does not persist it. These are policy checks and unit tests, **not yet a database-enforced transition guard or a live fulfilment workflow**; every future endpoint and worker must enforce the same rules inside its transaction. The current database/API does not yet support consent withdrawal on an existing order or an address vault, so no real dispatch can be enabled.

Only recipient may accept and enter address. The fail-closed fulfilment policy requires an explicit fresh safety-event snapshot (missing or unknown event state denies fulfilment), active adult sender and recipient accounts, current sender identity verification, recipient-entered verified address, recorded consent, matching authorized payment, and a final fresh relationship safety check. Block, report, restriction, account deletion, or consent withdrawal in that snapshot denies fulfilment. Block/report/restriction/account deletion/consent withdrawal suspends fulfilment and triggers review; after dispatch, request carrier stop/return if supported. Declined/expired requests never reveal address and must not charge; release authorization/refund per disclosed terms. A gift cannot buy affection, a reply, a date, or contact exchange. No sender tracking map, live courier location, exact handoff instructions or delivery phone number.

## Fraud and abuse controls
- **Stalking/address harvesting:** address collected only after acceptance, never in sender payloads/logs/URLs; per-order scoped carrier access, encryption, retention deletion and access audit.
- **Repeated unwanted gifts/coercion:** opt-in to gift requests, one pending request per pair, rate limits/cooldowns, recipient disable/report/block, no guilt-inducing reminders or public generosity badges.
- **Fake profiles/stolen cards:** account verification, payment risk/velocity checks, SCA where applicable, delayed fulfilment until payment and fraud checks pass, chargeback monitoring.
- **Phishing/solicitation:** moderated length-capped note, reject URLs, handles, phone numbers, payment requests and arbitrary files.
- **Dangerous/illegal goods:** exclude cash, gift cards, alcohol, tobacco/nicotine, drugs/medicines, weapons, adult items, crypto, gambling products and unreviewed/custom items; check local laws, allergens, food safety, customs and age restrictions.
- **Supplier/driver misuse:** vetted partner, processor contract, minimum data, least-privilege access, incident response and regional transfer review.
- **Forged delivery/replay:** webhook signature/timestamp verification, idempotency, legal state transitions and order reconciliation.
- **Refund/chargeback abuse:** separate sender/recipient/provider identities, fair dispute flow, no off-platform payout, never disclose recipient address as evidence.
- **Wrong-person delivery:** recipient verifies address and chooses delivery/pickup method; sender cannot set private delivery instructions.
- **Safety event:** suspend before dispatch; safety/support team can pause order without exposing report details to sender.

Unknown, stale, contradictory or unavailable eligibility/payment/provider data must fail closed. Do not expose reasons such as “reported” to the sender. Never grant ranking, messaging or visibility boosts for gifts.

## Country/city and partners
Use a vetted provider's maintained service-area catalogue, not guessed country codes or sender-entered address. Resolve recipient's delivery region server-side. Show sender only availability and an estimate, without confirming private location. If no partner covers the region, do not collect address; offer recipient-selected safe pickup where available or cancel/refund. Launch country by country after review of consumer, privacy/data residency, cross-border transfer, tax/VAT, food/allergen, import/customs and courier requirements. No global courier integration is assumed.

## Advertising and payments
Sponsored gift placements are ads: label them and apply ad consent, campaign eligibility, frequency and disclosure rules. Opening the gift catalog is a service action and does not silently grant ad consent. Keep ad billing, physical gift orders/supplier refunds and Vow Premium subscriptions as separate order types and ledgers. Paddle is only a possible future option for eligible Vow Premium billing; do not assume it supports physical goods or third-party marketplace payments. Verify processor terms and legal obligations before launch. No Stripe integration.

## Release gates
Before real orders: database-backed requests and immutable consent history; encrypted address vault and retention job; recipient-only accept/decline/report UI; sender-safe payload projection; signed provider API/webhooks; idempotent fulfilment and reconciliation; CSRF/origin/session checks; per-order authorization; payment/refund design; supplier/country catalog; support escalation and emergency kill switch. Test cross-account access, replayed acceptance, expiry/decline, blocks/reports before and after acceptance, rate limits, forged webhooks, provider outage, refund and address redaction.

Implemented in this branch: policy and eligibility helpers; database tables for recipient gift-request preferences, reviewed catalog items, delivery partner coverage, order states and order audit events; authenticated GET/PUT preference endpoints (default off, CSRF/origin-protected writes); a sender/recipient-scoped order list that deliberately omits address and contact fields; and a recipient-only transactional accept/decline endpoint with expiry, account, match, preference, block, and open-report checks. The decision endpoint records consent only; it does not create orders, authorize payment, grant address access, or connect to a carrier. The preference panel exists, but the recipient decision UI, order creation API, trusted identity-verification source, encrypted address vault, payment authorization/refund integration, provider API/webhooks, consent withdrawal for existing orders, and retention/deletion jobs remain release blockers. This code must not charge, order, or dispatch real gifts.
