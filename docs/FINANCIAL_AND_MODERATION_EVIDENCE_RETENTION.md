# Financial and moderation evidence retention

This policy describes the data boundaries implemented in the repository. It does **not** assign legal retention periods. Those periods must be approved for each operating jurisdiction before production launch; the application must not silently invent a universal expiry.

## Paddle billing

- `paddle_webhook_events` stores only Paddle's event ID, event type and local processing timestamp. It does not store the signed request body, payment credentials, billing address or customer email.
- The event ledger is immutable. Do not delete deduplication IDs on a short rolling TTL: a delayed/manual provider redelivery must not be allowed to reapply a financial event. Any future compaction must preserve a durable replay barrier and be reviewed against Paddle's current redelivery/replay guarantees.
- `paddle_checkout_attempts` stores the current attempt for an account. A provider-confirmed `completed` attempt may make only a status-only finalization to `linked` or `reconciliation_required`; ownership, plan, attempt ID and transaction ID remain immutable during that step. When a terminal attempt is replaced by a new attempt, the previous attempt ID, transaction ID, plan, terminal status (`canceled`, `linked`, or `completed`) and timestamps are copied transactionally into `paddle_checkout_attempt_history`. The database trigger permits only this atomic rollover with a fresh UUID and cleared transaction ID; ownership, attempt identity, plan and an attached provider transaction remain immutable outside that operation.
- Every valid `transaction.paid`, `transaction.completed` and `transaction.canceled` webhook is also retained in the append-only `paddle_transaction_events` ledger, independently of the per-user checkout pointer. A `transaction.paid` event and verified recurring `subscription.created` event are retained with status `paid`, not `completed`: Paddle sends `transaction.paid` when payment is captured, and `subscription.created` can arrive before transaction processing completes. A later `transaction.completed` event is retained separately, and the database permits only the valid `paid` → `completed` progression; it rejects any completed/canceled contradiction. This includes recurring renewal transactions and snapshots the amount in provider minor units plus ISO currency code; provider events that cannot be uniquely linked to an account remain recorded with `user_id = NULL` for reconciliation.
- Transaction totals are not collapsed: `amount_minor_units` stores Paddle `details.totals.total` (after discount/tax, before credits), `grand_total_minor_units` stores `grand_total` (after credits, before payments), `credit_minor_units` stores applied credit, and `balance_minor_units` stores the remaining amount after credits/payments. The paid amount can be reconciled from `grand_total_minor_units - balance_minor_units`; signed values are preserved because Paddle can emit negative totals for subscription updates that result in credit. The added breakdown fields remain `NULL` for historical events that predate migration 151 because their full webhook payloads were deliberately not retained.
- Current and historical checkout records restrict hard deletion of the referenced user row. The supported account-erasure path is a tombstone, which preserves the minimum financial identity needed for reconciliation. It does not retain card data or full provider payloads.
- Do not purge attempts in `creating`, `pending`, `completed` or `reconciliation_required` states until the provider state and any refund/cancellation obligation have been reconciled. An outbox task is not proof that a provider action completed.

## Paddle adjustments and lifetime access

- Every `adjustment.created` and `adjustment.updated` event with a valid action/identity/status is retained as a minimal append-only record in `paddle_adjustment_events`, including event ID, adjustment ID, transaction ID, action, full/partial type when valid, status, amount in provider minor units and ISO currency code when valid, and provider event time. Missing or invalid amount/currency metadata is stored as `NULL` and opens a reconciliation case; it does not suppress an otherwise verified full-refund or chargeback entitlement action. Migration 184 also enforces global adjustment-ID identity: transaction and action cannot change, and already-known type/amount/currency values cannot conflict; a later event may fill metadata that was previously absent. A conflicting signed event is acknowledged with its deduplication ID retained and placed in the provider-identity reconciliation queue rather than entering the normalized ledger. Migration 185 also preserves the validated `provider_adjustment_id` when that conflicting event cannot enter the ledger, exposes it in the moderator queue, and includes it in the immutable manual-resolution audit.
- Refund actions require an explicit `full` or `partial` scope. A missing or unknown refund scope is retained with `adjustment_type = NULL` and an open reconciliation case; it is never inferred as full, cannot revoke lifetime access, and cannot supersede a previously verified adjustment state. Chargeback decisions are based on the signed action/status and are not blocked by unrelated malformed type metadata, though the malformed event remains queued for review.
- Valid adjustments that cannot yet be matched to a unique Vow checkout, and malformed adjustment webhook payloads that cannot safely enter the normalized ledger, are copied into `paddle_adjustment_reconciliation_cases` with a bounded reason code and any provider adjustment/transaction IDs that independently pass strict format validation. Invalid identifiers and the raw webhook payload are never copied into the queue. The source adjustment remains immutable; the case stays open until a verified checkout/entitlement link resolves it or an authorized operator records a bounded resolution note. Query `WHERE status = 'open'` for the operational queue; never discard the case to clear an alert. Resolution records distinguish automatic provider transaction/account linkage from manual operator action and retain an opaque `resolved_by_ref` for manual decisions. Provider identity/lifecycle conflict cases also retain only the validated transaction ID, adjustment ID when applicable, opaque account UUID and bounded plan needed for investigation; these source fields are immutable and included in the moderator audit when a case is resolved. The database rejects automatic closure unless the immutable adjustment event resolves to exactly one owner across current/archived checkout attempts or an eligible completed transaction event; a caller cannot select the automatic source merely to avoid moderator audit.
- A refund in `pending_approval` does not revoke Premium, and a rejected refund with no prior approval does not revoke it. Only an approved full refund revokes the lifetime entitlement tied to that exact transaction; partial refunds and credits do not automatically revoke the lifetime plan. Paddle documents approval/rejection as mutually exclusive final outcomes. If a later `pending_approval` or `rejected` event conflicts with an earlier approval for the same adjustment, retain the approved refund as adverse, open a `provider_lifecycle_conflict` reconciliation case, and do not restore access. Paddle documents `chargeback_reverse` for chargeback reversals and `credit_reverse` for credit reversals, but no refund-reversal action; a full refund that was approved therefore remains adverse. A `reversed` status on a refund adjustment is treated as a provider-lifecycle conflict, retained for moderator review, and never restores lifetime access automatically.
- A chargeback revokes the entitlement tied to its transaction. Paddle creates a separate `chargeback_reverse` adjustment when it successfully contests a dispute; do not wait for `adjustment.updated` on the original chargeback, because Paddle documents that event for refunds awaiting manual approval and says to listen to `adjustment.created` for all adjustments. Reconcile approved chargeback and `chargeback_reverse` records by transaction, exact non-null amount and currency, and provider-event chronology. Pair one-to-one within each amount/currency group rather than by a global sequence, because Paddle may create reversals for different chargeback amounts or currencies in a different order; a single reversal must never offset multiple chargebacks. Restore access only when every recorded chargeback has its own later approved reversal and no approved full refund or unmatched chargeback remains. A delayed original-chargeback webhook recomputes against already-recorded reversal evidence. Chargeback warnings and warning reversals are retained but do not by themselves revoke access.
- Lifetime entitlement provenance is stored by transaction ID in `paddle_lifetime_entitlements`. Reconciliation is scoped to exactly one linked lifetime checkout owner across current and archived attempts; contradictory provider transaction history or ambiguous owners fail closed. The migration backfill also fails closed if a linked lifetime transaction ID is associated with more than one Vow account; resolve that data conflict before applying the migration. Migration 155 enforces the owner/link relationship for every new or updated entitlement projection, while migration 137 freezes transaction/account identity and blocks deletion/TRUNCATE. Migration 157 requires every new checkout attempt to start as an unlinked `creating` row; provider linkage must pass through the guarded state transitions. Migration 158 requires every transition to `linked` to have a matching `transaction.completed` webhook ledger row for the same user, plan and transaction, and permits history inserts only from the nested terminal-rollover trigger. Migration 159 enforces provider transaction owner and plan consistency across current attempts, archived checkout history and the append-only transaction ledger; it fails closed if pre-existing cross-table duplicates need reconciliation. Migration 160 serializes cross-table claims with a transaction-scoped advisory lock and rechecks owner/plan updates, closing concurrent read-before-write races. Migration 161 fails closed on pre-existing owner or plan contradictions across all three evidence sources. Migration 162 classifies new cross-source owner/plan collisions as identity conflicts (`23505`), allowing webhook processing to retain the deduplication event and queue the exact checkout attempt for reconciliation instead of retrying the same signed event indefinitely. Migration 163 also rejects a contradictory `completed`/`canceled` state for the same Paddle transaction; Paddle defines these as distinct transaction lifecycle statuses, and a canceled transaction must not later be treated as a completed purchase. Migration 164 adds bounded provider identity/lifecycle conflict reasons to the moderator reconciliation queue; webhook processing rolls back disputed effects, preserves the event ID, and records the conflict even when the affected checkout is already terminal. Migration 165 adds the distinct `paid` transaction state and updates linked recurring checkout evidence accordingly; migration 166 applies the same captured-payment semantics to automatic adjustment reconciliation. Migration 170 requires every paid ledger row to originate from `transaction.paid` or a verified `subscription.created` event and checks every supplied customer/subscription ID against the stored owner identity. Migration 171 accounts for Paddle's ordering by allowing `transaction.paid` to precede storage of a new subscription ID while still rejecting any contradiction with an already stored customer or subscription identity. Migration 175 also accepts the exact server-created checkout attempt as owner evidence when `transaction.paid` arrives before Vow has stored the Paddle customer or subscription ID. Migration 183 locks provider identity writes while it fails closed on historical cross-event customer/subscription conflicts, then serializes both transaction-event inserts and user-row identity assignments in shared customer/subscription lock namespaces. It rejects provider identities already owned by another Vow account, including identities retained in prior transaction events after live account fields are cleared; new webhook conflicts are routed to manual reconciliation. Migration 182 limits recipient opt-out timestamps to existing orders that are still awaiting recipient consent.
- Reversal processing recomputes access from all verified lifetime purchases for the account, so an adjustment against one transaction does not revoke another independently valid lifetime purchase.


Operational queue query:

```sql
SELECT c.event_id, c.reason_code, COALESCE(e.adjustment_id, c.provider_adjustment_id) AS adjustment_id, COALESCE(e.transaction_id, c.provider_transaction_id) AS transaction_id, c.created_at
FROM paddle_adjustment_reconciliation_cases AS c
LEFT JOIN paddle_adjustment_events AS e USING (event_id)
WHERE c.status = 'open'
ORDER BY c.created_at ASC;
```

A manual resolution must set `status = 'resolved'`, a concise `resolution_note`, `resolution_source = 'manual_operator'`, and the operator's opaque UUID in `resolved_by_ref`. Database enforcement rejects manual closure for unlinked or ambiguous transaction owners, inactive accounts, and missing lifetime-entitlement provenance, even if an audit row is supplied. Automatic closure is reserved for a verified Vow provider transaction/account link and is marked `automatic_provider_transaction_link`.

The normal operator workflow is available through the moderator API:

- `GET /api/admin/paddle-adjustment-reconciliation` lists open cases (maximum 100 per request) and returns a stable `nextCursor`; pass both `afterCreatedAt` and `afterEventId` from that cursor to retrieve the next page without offset-pagination skips.
- `POST /api/admin/paddle-adjustment-reconciliation/:eventId/resolve` accepts `{ "resolutionNote": "..." }`. It requires an active admin/moderator session and a same-origin request; the note is trimmed and limited to 500 characters. Manual closure is restricted to reviewed malformed-payload and provider identity/lifecycle conflict cases from `adjustment.*` or `customer.*` webhooks where no unresolved entitlement-owner linkage is being waived; transaction/subscription lifecycle conflicts remain open for verified transaction reconciliation. `transaction_owner_unlinked`, `transaction_owner_ambiguous`, `lifetime_account_inactive`, and `lifetime_entitlement_missing` remain open until a verified transaction/account or entitlement remediation exists; a moderator note cannot clear them.
- The resolver locks the open case, rechecks the moderator role against the database, and writes the case resolution plus `moderation_audit_log` entry in one transaction. A deferred database constraint trigger also rejects any manual resolution that reaches commit without a matching immutable audit row for the same event, active moderator, reason, and resolution source; the actor must still have an active `admin` or `moderator` role at commit. Repeated resolution attempts fail because resolved cases are immutable.
- This endpoint only closes the operational case. It never grants, revokes, or restores Premium. Entitlement changes remain exclusively tied to verified Paddle adjustment and lifetime-entitlement evidence.

The SQL procedure below is a break-glass fallback for a controlled database operator when the moderator API is unavailable; it must not be used as the routine workflow.

Manual operator runbook (execute through the audited production database role; do not run from application code):

1. Inspect the open case and its immutable source event. Verify the transaction, adjustment status, customer, currency, amount, and Vow account against Paddle's authenticated dashboard/API and the checkout/entitlement ledgers. Do not resolve an ambiguous owner by email or display name alone. If ownership or provider state cannot be proven, leave the case open.
2. Resolve and write the moderation audit entry atomically. Substitute psql variables only after completing the provider-side verification. The note must state the provider evidence checked and the operational outcome; it must not contain payment credentials or full provider payloads.

```sql
BEGIN;

SELECT c.event_id, c.reason_code, COALESCE(e.adjustment_id, c.provider_adjustment_id) AS adjustment_id, COALESCE(e.transaction_id, c.provider_transaction_id) AS transaction_id,
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
    AND c.reason_code IN (
      'invalid_adjustment_payload',
      'provider_identity_conflict',
      'provider_lifecycle_conflict'
    )
    AND EXISTS (
      SELECT 1 FROM paddle_webhook_events AS webhook
      WHERE webhook.event_id = c.event_id
        AND webhook.event_type IN (
          'adjustment.created', 'adjustment.updated',
          'customer.created', 'customer.updated'
        )
    )
    AND length(btrim(:'resolution_note')) BETWEEN 1 AND 1000
    AND EXISTS (
      SELECT 1 FROM users AS u
      WHERE u.id = :'moderator_id'::uuid
        AND u.status = 'active'
        AND u.role IN ('admin', 'moderator')
    )
  RETURNING c.event_id, c.reason_code, c.provider_adjustment_id,
            c.provider_transaction_id, c.provider_user_ref, c.provider_plan
)
INSERT INTO moderation_audit_log
  (moderator_id, action, target_type, target_id, reason, details)
SELECT :'moderator_id'::uuid,
       'paddle_adjustment_reconciliation_resolved',
       'paddle_adjustment_case',
       resolved_case.event_id,
       btrim(:'resolution_note'),
       jsonb_build_object(
         'eventId', resolved_case.event_id,
         'reasonCode', resolved_case.reason_code,
         'adjustmentId', COALESCE(source.adjustment_id, resolved_case.provider_adjustment_id),
         'transactionId', COALESCE(source.transaction_id, resolved_case.provider_transaction_id),
         'providerUserRef', resolved_case.provider_user_ref,
         'providerPlan', resolved_case.provider_plan,
         'resolutionSource', 'manual_operator'
       )
FROM resolved_case
LEFT JOIN paddle_adjustment_events AS source USING (event_id)
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
- Reports survive physical account erasure: immutable `reporter_ref` and `reported_user_ref` snapshots preserve both UUIDs while the live `reporter_id` and `reported_user_id` FKs are set to NULL. Report content and identity cannot be updated, deleted or truncated. Moderators may review or dismiss a retained report after account erasure; suspension requires a live target account.
- `moderation_audit_log` is append-only. New rows automatically snapshot the moderator UUID in `moderator_ref`; if a moderator account is physically removed through a separately approved retention operation, the live FK may be nulled by PostgreSQL while the immutable actor reference and action record remain.
- Report details are user-supplied free text. The UI and moderator workflow must treat it as potentially sensitive and must not copy it into unrelated analytics, ad targeting, or general-purpose logs. The audit log should contain bounded reason codes and references, not the full report text.
- Photo upload identity and file metadata are immutable after creation; only the audited `review_status` lifecycle may change. Photo bytes/rows may still be deleted for account privacy, but `photo_ai_approved` evidence retains the uploader UUID, and photo evidence cannot be truncated.
- Safety-screening classification evidence (`user_ref` owner snapshot, scope, flags, severity, engine version and creation time) is immutable. The live owner FK may be nulled on physical account deletion while `user_ref` preserves the opaque UUID; direct deletion/TRUNCATE and direct owner nullification are blocked. Rows are created only as `pending` or `not_required`, and any review-state change requires a matching immutable audit entry from the same active moderator recorded in `reviewed_by`.

## Gift and delivery evidence

- Gift purchase identity, product/price/currency snapshots, delivery-partner UUID/key/name provenance and idempotency facts are immutable; order/payment lifecycle fields remain mutable through guarded transitions. Gift orders cannot be deleted or truncated.
- `gift_delivery_order_events` is append-only. Its `actor_ref` snapshot is populated on insert and preserves the original actor UUID when the live `actor_user_id` FK is nulled after account deletion. New gift orders snapshot `catalog_item_id` and `delivery_partner_id`; partner key and display name are also copied so a deleted live partner cannot erase human-readable provenance. Direct update/delete and truncation are blocked.
- Recipient opt-out is a permanent per-request fact: its timestamp cannot be cleared or rewritten, and the database emits an append-only `recipient_opted_out` event even when the request had no active payment requiring reconciliation.
- Gift payment reconciliation tasks may advance through worker states but cannot be deleted or truncated. They remain until a separately approved retention process exists.
- The order tables must contain only opaque address-vault references, never street address, phone, email, coordinates or delivery instructions. Account deletion/safety actions remove pre-dispatch address pointers and enqueue payment reconciliation without pretending a refund or void occurred.

## Migration ordering dependency

Deploy migrations 135–197 from PR #424 before merging and deploying PR #423's migration 134. Migration 145 closes a direct-update loophole in the live foreign-key snapshot exceptions for L3 media access and gift-order actor evidence; only nested PostgreSQL `ON DELETE SET NULL` actions may clear those live references. Migration 186 restricts manual Paddle reconciliation closure to reviewed malformed-payload/provider-identity/provider-lifecycle cases with matching immutable moderator evidence; ambiguous owner, inactive-account and missing-entitlement cases must remain open until verified provider linkage exists. Migration 187 enforces global uniqueness of live Paddle customer and subscription IDs and rejects reassignment against retained transaction ownership. Migration 188 requires new L3 media-access audit rows to carry live submission and moderator foreign keys; opaque snapshots cannot be forged as detached provenance at insert time. Migration 189 requires gift-event and moderation-audit actor snapshots to derive from their live actor foreign keys; system-generated events may leave both live and snapshot actor IDs NULL, but cannot claim an arbitrary UUID. Migration 190 derives catalog UUID snapshots only from live catalog references and rejects detached caller-supplied snapshots, while preserving valid catalog-less legacy/system orders. Migration 191 blocks direct insertion of fabricated L3 decision events; only the guarded submission-state trigger may emit processing, approval, rejection, withdrawal and expiry history. Migration 192 adds statement-level `TRUNCATE` guards to the L3 consent and decision event ledgers, complementing their row-level append-only triggers. Migration 193 prevents deleting submissions with live encrypted media, deleting unfinished purge jobs, or truncating the submission/purge tables; only a completed purge job may disappear through deletion of its already-purged submission. Migration 194 requires the purge job to complete only after its submission key is cleared, and requires every new media_purged_at timestamp to have a matching completed job in the same transaction. Migration 195 prevents deletion or truncation of current L3 consent state for active accounts; consent must be withdrawn through the audited workflow that revokes approvals and queues media purge. Migration 196 makes that workflow a deferred database invariant: every active submission must be withdrawn/revoked and every retained encrypted object must have a durable purge job before the withdrawal transaction can commit. Migration 197 freezes consent ownership and requires each grant, notice-version update and withdrawal to carry a matching append-only consent event in the same transaction. Confirm `schema_migrations` contains `136_adjustment_and_l3_access_evidence.sql`, `148_require_manual_adjustment_resolution_audit.sql`, `149_require_user_report_status_audit.sql`, `150_require_photo_and_screening_review_audit.sql`, and `151_preserve_paddle_transaction_total_breakdown.sql`, `152_guard_safety_screening_reviewer_fk_nullification.sql`, and `153_bound_signed_paddle_transaction_amount.sql`, and `154_require_verified_automatic_adjustment_link.sql`, `155_guard_lifetime_entitlement_provenance.sql`, `156_preserve_photo_and_screening_evidence.sql`, and `157_require_initial_checkout_attempt_state.sql`, and `158_require_verified_checkout_linkage.sql`, plus the follow-up Paddle identity/lifecycle migrations 159–175 and 183–197, gift evidence migrations 176–179 and 182, and report retention migrations 180–181, before migration 134 is introduced to a deployment. The migration runner applies newly discovered files in filename order; if migrations 134 and 136 are both pending in the same deployment, 134 would run first and could cascade-delete historical L3 access events before their retention foreign keys are changed. Do not merge both PRs into one undeployed release.

## Operational requirements before production

1. Approve a jurisdiction-specific retention schedule with counsel for reports, moderation decisions, Paddle transaction references, gift/payment disputes, identity verification and audit records.
2. Define the legal-hold and dispute workflow before enabling any automated purge. A legal hold must override ordinary expiry.
3. Restrict database and audit-log access to authorized operational/moderation roles; protect backups and exports with encryption and access logging.
4. Monitor reconciliation queues and unresolved payment attempts. Never delete unresolved financial evidence to reduce storage.
5. If a retention schedule is later automated, use explicit per-record `retain_until` / legal-hold state, a dry-run report, bounded batches, and an immutable purge audit. Do not add a blanket cascade or age-only delete job.

No automated financial/report evidence purge is enabled by this change. That is deliberate until the retention periods and legal-hold rules are approved.


Lifetime entitlement projections are tied to exactly one linked lifetime checkout owner by migration 155. Transaction/account identity immutability and deletion/TRUNCATE protection remain enforced by migration 137.
