# Financial and moderation evidence retention

This policy describes the data boundaries implemented in the repository. It does **not** assign legal retention periods. Those periods must be approved for each operating jurisdiction before production launch; the application must not silently invent a universal expiry.

## Paddle billing

- `paddle_webhook_events` stores only Paddle's event ID, event type and local processing timestamp. It does not store the signed request body, payment credentials, billing address or customer email.
- The event ledger is immutable. Do not delete deduplication IDs on a short rolling TTL: a delayed/manual provider redelivery must not be allowed to reapply a financial event. Any future compaction must preserve a durable replay barrier and be reviewed against Paddle's current redelivery/replay guarantees.
- `paddle_checkout_attempts` stores the current attempt for an account. A provider-confirmed `completed` attempt may make only a status-only finalization to `linked` or `reconciliation_required`; ownership, plan, attempt ID and transaction ID remain immutable during that step. When a terminal attempt is replaced by a new attempt, the previous attempt ID, transaction ID, plan, terminal status (`canceled`, `linked`, or `completed`) and timestamps are copied transactionally into `paddle_checkout_attempt_history`. The database trigger permits only this atomic rollover with a fresh UUID and cleared transaction ID; ownership, attempt identity, plan and an attached provider transaction remain immutable outside that operation.
- Every valid `transaction.completed` and `transaction.canceled` webhook is also retained in the append-only `paddle_transaction_events` ledger, independently of the per-user checkout pointer. This includes recurring renewal transactions and snapshots the amount in provider minor units plus ISO currency code; provider events that cannot be uniquely linked to an account remain recorded with `user_id = NULL` for reconciliation.
- Transaction totals are not collapsed: `amount_minor_units` stores Paddle `details.totals.total` (after discount/tax, before credits), `grand_total_minor_units` stores `grand_total` (after credits, before payments), `credit_minor_units` stores applied credit, and `balance_minor_units` stores the remaining amount after credits/payments. The paid amount can be reconciled from `grand_total_minor_units - balance_minor_units`; signed values are preserved because Paddle can emit negative totals for subscription updates that result in credit. The added breakdown fields remain `NULL` for historical events that predate migration 151 because their full webhook payloads were deliberately not retained.
- Current and historical checkout records restrict hard deletion of the referenced user row. The supported account-erasure path is a tombstone, which preserves the minimum financial identity needed for reconciliation. It does not retain card data or full provider payloads.
- Do not purge attempts in `creating`, `pending`, `completed` or `reconciliation_required` states until the provider state and any refund/cancellation obligation have been reconciled. An outbox task is not proof that a provider action completed.

## Paddle adjustments and lifetime access

- Every `adjustment.created` and `adjustment.updated` event with a valid action/identity/status is retained as a minimal append-only record in `paddle_adjustment_events`, including event ID, adjustment ID, transaction ID, action, full/partial type when valid, status, amount in provider minor units and ISO currency code when valid, and provider event time. Missing or invalid amount/currency metadata is stored as `NULL` and opens a reconciliation case; it does not suppress an otherwise verified full-refund or chargeback entitlement action.
- Refund actions require an explicit `full` or `partial` scope. A missing or unknown refund scope is retained with `adjustment_type = NULL` and an open reconciliation case; it is never inferred as full, cannot revoke lifetime access, and cannot supersede a previously verified adjustment state. Chargeback decisions are based on the signed action/status and are not blocked by unrelated malformed type metadata, though the malformed event remains queued for review.
- Valid adjustments that cannot yet be matched to a unique Vow checkout, and malformed adjustment webhook payloads that cannot safely enter the normalized ledger, are copied into `paddle_adjustment_reconciliation_cases` with a bounded reason code. The source adjustment remains immutable; the case stays open until a verified checkout/entitlement link resolves it or an authorized operator records a bounded resolution note. Query `WHERE status = 'open'` for the operational queue; never discard the case to clear an alert. Resolution records distinguish automatic provider transaction linkage from manual operator action and retain an opaque `resolved_by_ref` for manual decisions. The database rejects automatic closure unless the immutable adjustment event resolves to exactly one owner across current/archived checkout attempts or an eligible completed transaction event; a caller cannot select the automatic source merely to avoid moderator audit.
- A refund in `pending_approval` does not revoke Premium. A rejected refund also does not revoke it. Only an approved full refund revokes the lifetime entitlement tied to that exact transaction; partial refunds and credits do not automatically revoke the lifetime plan.
- A chargeback revokes the entitlement tied to its transaction. Paddle's `chargeback_reverse` is a separate adjustment action and is not itself proof that the original chargeback is inactive. Access can be restored only after the original chargeback adjustment is recorded with status `reversed` and no other approved full refund or active chargeback remains for that transaction. Chargeback warnings and warning reversals are retained but do not by themselves revoke access.
- Lifetime entitlement provenance is stored by transaction ID in `paddle_lifetime_entitlements`. Reconciliation is scoped to the verified lifetime checkout attempt; unknown or ambiguous transactions are retained for manual reconciliation and never guessed. The migration backfill also fails closed if a linked lifetime transaction ID is associated with more than one Vow account across current and archived checkout attempts; resolve that data conflict before applying the migration.
- Reversal processing recomputes access from all verified lifetime purchases for the account, so an adjustment against one transaction does not revoke another independently valid lifetime purchase.


Operational queue query:

```sql
SELECT c.event_id, c.reason_code, e.adjustment_id, e.transaction_id, c.created_at
FROM paddle_adjustment_reconciliation_cases AS c
LEFT JOIN paddle_adjustment_events AS e USING (event_id)
WHERE c.status = 'open'
ORDER BY c.created_at ASC;
```

A manual resolution must set `status = 'resolved'`, a concise `resolution_note`, `resolution_source = 'manual_operator'`, and the operator's opaque UUID in `resolved_by_ref`. Automatic closure is reserved for a verified Vow checkout link and is marked `automatic_provider_transaction_link`.

The normal operator workflow is available through the moderator API:

- `GET /api/admin/paddle-adjustment-reconciliation` lists open cases (maximum 100 per request) and returns a stable `nextCursor`; pass both `afterCreatedAt` and `afterEventId` from that cursor to retrieve the next page without offset-pagination skips.
- `POST /api/admin/paddle-adjustment-reconciliation/:eventId/resolve` accepts `{ "resolutionNote": "..." }`. It requires an active admin/moderator session and a same-origin request; the note is trimmed and limited to 500 characters.
- The resolver locks the open case, rechecks the moderator role against the database, and writes the case resolution plus `moderation_audit_log` entry in one transaction. A deferred database constraint trigger also rejects any manual resolution that reaches commit without a matching immutable audit row for the same event, active moderator, reason, and resolution source; the actor must still have an active `admin` or `moderator` role at commit. Repeated resolution attempts fail because resolved cases are immutable.
- This endpoint only closes the operational case. It never grants, revokes, or restores Premium. Entitlement changes remain exclusively tied to verified Paddle adjustment and lifetime-entitlement evidence.

The SQL procedure below is a break-glass fallback for a controlled database operator when the moderator API is unavailable; it must not be used as the routine workflow.

Manual operator runbook (execute through the audited production database role; do not run from application code):

1. Inspect the open case and its immutable source event. Verify the transaction, adjustment status, customer, currency, amount, and Vow account against Paddle's authenticated dashboard/API and the checkout/entitlement ledgers. Do not resolve an ambiguous owner by email or display name alone. If ownership or provider state cannot be proven, leave the case open.
2. Resolve and write the moderation audit entry atomically. Substitute psql variables only after completing the provider-side verification. The note must state the provider evidence checked and the operational outcome; it must not contain payment credentials or full provider payloads.

```sql
BEGIN;

SELECT c.event_id, c.reason_code, e.adjustment_id, e.transaction_id,
       e.action, e.status AS adjustment_status,
       e.amount_minor_units, e.currency_code, c.created_at
FROM paddle_adjustment_reconciliation_cases AS c
LEFT JOIN paddle_adjustment_events AS e USING (event_id)
WHERE c.event_id = :'event_id' AND c.status = 'open'
FOR UPDATE OF c;

WITH resolved_case AS (
  UPDATE paddle_adjustment_reconciliation_cases AS c
  SET status = 'resolved',
      resolution_note = btrim(:'resolution_note'),
      resolution_source = 'manual_operator',
      resolved_by_ref = :'moderator_id'::uuid,
      resolved_at = statement_timestamp(),
      updated_at = statement_timestamp()
  WHERE c.event_id = :'event_id'
    AND c.status = 'open'
    AND length(btrim(:'resolution_note')) BETWEEN 1 AND 1000
    AND EXISTS (
      SELECT 1 FROM users AS u
      WHERE u.id = :'moderator_id'::uuid
        AND u.status = 'active'
        AND u.role IN ('admin', 'moderator')
    )
  RETURNING c.event_id, c.reason_code
)
INSERT INTO moderation_audit_log
  (moderator_id, action, target_type, target_id, reason, details)
SELECT :'moderator_id'::uuid,
       'paddle_adjustment_reconciliation_resolved',
       'paddle_adjustment_case',
       event_id,
       btrim(:'resolution_note'),
       jsonb_build_object(
         'eventId', event_id,
         'reasonCode', reason_code,
         'resolutionSource', 'manual_operator'
       )
FROM resolved_case
RETURNING id;

-- Require exactly one returned audit row. Otherwise ROLLBACK and investigate.
COMMIT;
```

This runbook closes only the operational case; it does not itself grant, revoke, or restore Premium. Any entitlement correction must be separately justified by the verified transaction and the immutable lifetime-entitlement ledger. Never use a manual case closure as a substitute for a provider-side refund/chargeback action.

## L3 media access audit

- `identity_l3_media_access_events` retains opaque `submission_ref` and `moderator_ref` snapshots after the video and workflow submission are physically deleted.
- Live foreign keys are nullable and use `ON DELETE SET NULL`; only the nested FK action may clear them. Direct `UPDATE` and `DELETE` remain prohibited.
- The audit record contains no video bytes, storage path, IP address, or contact data. Its retention period must be set by the same jurisdiction-specific schedule and legal-hold process as other moderation evidence.

## User reports and moderation

- A report's reporter, target, category, submitted details and creation time are immutable. Reports must be inserted as `open`. Moderation can move status from `open` to `reviewing`, `resolved` or `dismissed`, and from `reviewing` to a terminal status; every status transition requires a matching append-only audit row for the same report and resulting status, written by an active admin/moderator in the same transaction.
- Hard deletion of either account is restricted while a report references it. The normal account deletion workflow uses a deleted-account tombstone and therefore does not erase report evidence.
- `moderation_audit_log` is append-only. New rows automatically snapshot the moderator UUID in `moderator_ref`; if a moderator account is physically removed through a separately approved retention operation, the live FK may be nulled by PostgreSQL while the immutable actor reference and action record remain.
- Report details are user-supplied free text. The UI and moderator workflow must treat it as potentially sensitive and must not copy it into unrelated analytics, ad targeting, or general-purpose logs. The audit log should contain bounded reason codes and references, not the full report text.
- Photo review-state changes require a matching immutable audit entry from an active moderator. Automated photo approval is a separate path and must carry its own `photo_ai_approved` evidence; a direct SQL insert cannot create an already-rejected photo or an unaudited approved photo.
- Safety-screening rows are created only as `pending` or `not_required`. Any later review-state change requires a matching immutable audit entry from the same active moderator recorded in `reviewed_by`; clearance cannot be manufactured by direct SQL.

## Gift and delivery evidence

- Gift purchase identity, product/price/currency snapshots and idempotency facts are immutable; order/payment lifecycle fields remain mutable through guarded transitions. Gift orders cannot be deleted or truncated.
- `gift_delivery_order_events` is append-only. Its `actor_ref` snapshot is populated on insert and preserves the original actor UUID when the live `actor_user_id` FK is nulled after account deletion. New gift orders also snapshot `catalog_item_id` and `delivery_partner_id` into immutable `catalog_item_ref` and `delivery_partner_ref` fields before either live FK can be nulled. Direct update/delete and truncation are blocked.
- Gift payment reconciliation tasks may advance through worker states but cannot be deleted or truncated. They remain until a separately approved retention process exists.
- The order tables must contain only opaque address-vault references, never street address, phone, email, coordinates or delivery instructions. Account deletion/safety actions remove pre-dispatch address pointers and enqueue payment reconciliation without pretending a refund or void occurred.

## Migration ordering dependency

Deploy migrations 135–154 from PR #424 before merging and deploying PR #423's migration 134. Migration 145 closes a direct-update loophole in the live foreign-key snapshot exceptions for L3 media access and gift-order actor evidence; only nested PostgreSQL `ON DELETE SET NULL` actions may clear those live references. Confirm `schema_migrations` contains `136_adjustment_and_l3_access_evidence.sql`, `148_require_manual_adjustment_resolution_audit.sql`, `149_require_user_report_status_audit.sql`, `150_require_photo_and_screening_review_audit.sql`, and `151_preserve_paddle_transaction_total_breakdown.sql`, and `152_guard_safety_screening_reviewer_fk_nullification.sql`,  `153_bound_signed_paddle_transaction_amount.sql`, and `154_require_verified_automatic_adjustment_link.sql` before migration 134 is introduced to a deployment. The migration runner applies newly discovered files in filename order; if migrations 134 and 136 are both pending in the same deployment, 134 would run first and could cascade-delete historical L3 access events before their retention foreign keys are changed. Do not merge both PRs into one undeployed release.

## Operational requirements before production

1. Approve a jurisdiction-specific retention schedule with counsel for reports, moderation decisions, Paddle transaction references, gift/payment disputes, identity verification and audit records.
2. Define the legal-hold and dispute workflow before enabling any automated purge. A legal hold must override ordinary expiry.
3. Restrict database and audit-log access to authorized operational/moderation roles; protect backups and exports with encryption and access logging.
4. Monitor reconciliation queues and unresolved payment attempts. Never delete unresolved financial evidence to reduce storage.
5. If a retention schedule is later automated, use explicit per-record `retain_until` / legal-hold state, a dry-run report, bounded batches, and an immutable purge audit. Do not add a blanket cascade or age-only delete job.

No automated financial/report evidence purge is enabled by this change. That is deliberate until the retention periods and legal-hold rules are approved.
