# Financial and moderation evidence retention

This policy describes the data boundaries implemented in the repository. It does **not** assign legal retention periods. Those periods must be approved for each operating jurisdiction before production launch; the application must not silently invent a universal expiry.

## Paddle billing

- `paddle_webhook_events` stores only Paddle's event ID, event type and local processing timestamp. It does not store the signed request body, payment credentials, billing address or customer email.
- The event ledger is immutable. Do not delete deduplication IDs on a short rolling TTL: a delayed/manual provider redelivery must not be allowed to reapply a financial event. Any future compaction must preserve a durable replay barrier and be reviewed against Paddle's current redelivery/replay guarantees.
- `paddle_checkout_attempts` stores the current attempt for an account. When a terminal attempt is replaced by a new attempt, the previous attempt ID, transaction ID, plan, terminal status (`canceled`, `linked`, or `completed`) and timestamps are copied transactionally into `paddle_checkout_attempt_history`.
- Every valid `transaction.completed` and `transaction.canceled` webhook is also retained in the append-only `paddle_transaction_events` ledger, independently of the per-user checkout pointer. This includes recurring renewal transactions and snapshots the amount in provider minor units plus ISO currency code; provider events that cannot be uniquely linked to an account remain recorded with `user_id = NULL` for reconciliation.
- Current and historical checkout records restrict hard deletion of the referenced user row. The supported account-erasure path is a tombstone, which preserves the minimum financial identity needed for reconciliation. It does not retain card data or full provider payloads.
- Do not purge attempts in `creating`, `pending`, `completed` or `reconciliation_required` states until the provider state and any refund/cancellation obligation have been reconciled. An outbox task is not proof that a provider action completed.

## Paddle adjustments and lifetime access

- Every `adjustment.created` and `adjustment.updated` event is retained as a minimal append-only record in `paddle_adjustment_events`, including event ID, adjustment ID, transaction ID, action, full/partial type, status, amount in provider minor units, ISO currency code and provider event time.
- Valid adjustments that cannot yet be matched to a unique Vow checkout, and malformed adjustment webhook payloads that cannot safely enter the normalized ledger, are copied into `paddle_adjustment_reconciliation_cases` with a bounded reason code. The source adjustment remains immutable; the case stays open until a verified checkout/entitlement link resolves it or an authorized operator records a bounded resolution note. Query `WHERE status = 'open'` for the operational queue; never discard the case to clear an alert. Resolution records distinguish automatic provider transaction linkage from manual operator action and retain an opaque `resolved_by_ref` for manual decisions.
- A refund in `pending_approval` does not revoke Premium. A rejected refund also does not revoke it. Only an approved full refund revokes the lifetime entitlement tied to that exact transaction; partial refunds and credits do not automatically revoke the lifetime plan.
- A chargeback revokes the entitlement tied to its transaction. A chargeback reversal can restore it only when no other approved full refund or active chargeback remains for that transaction. Chargeback warnings are retained but do not by themselves revoke access.
- Lifetime entitlement provenance is stored by transaction ID in `paddle_lifetime_entitlements`. Reconciliation is scoped to the verified lifetime checkout attempt; unknown or ambiguous transactions are retained for manual reconciliation and never guessed.
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

## L3 media access audit

- `identity_l3_media_access_events` retains opaque `submission_ref` and `moderator_ref` snapshots after the video and workflow submission are physically deleted.
- Live foreign keys are nullable and use `ON DELETE SET NULL`; only the nested FK action may clear them. Direct `UPDATE` and `DELETE` remain prohibited.
- The audit record contains no video bytes, storage path, IP address, or contact data. Its retention period must be set by the same jurisdiction-specific schedule and legal-hold process as other moderation evidence.

## User reports and moderation

- A report's reporter, target, category, submitted details and creation time are immutable. Moderation can move status from `open` to `reviewing`, `resolved` or `dismissed`, and from `reviewing` to a terminal status.
- Hard deletion of either account is restricted while a report references it. The normal account deletion workflow uses a deleted-account tombstone and therefore does not erase report evidence.
- `moderation_audit_log` is append-only. New rows automatically snapshot the moderator UUID in `moderator_ref`; if a moderator account is physically removed through a separately approved retention operation, the live FK may be nulled by PostgreSQL while the immutable actor reference and action record remain.
- Report details are user-supplied free text. The UI and moderator workflow must treat it as potentially sensitive and must not copy it into unrelated analytics, ad targeting, or general-purpose logs. The audit log should contain bounded reason codes and references, not the full report text.

## Gift and delivery evidence

- Gift purchase identity, product/price/currency snapshots and idempotency facts are immutable; order/payment lifecycle fields remain mutable through guarded transitions. Gift orders cannot be deleted or truncated.
- `gift_delivery_order_events` is append-only. Its `actor_ref` snapshot is populated on insert and preserves the original actor UUID when the live `actor_user_id` FK is nulled after account deletion. New gift orders also snapshot `catalog_item_id` and `delivery_partner_id` into immutable `catalog_item_ref` and `delivery_partner_ref` fields before either live FK can be nulled. Direct update/delete and truncation are blocked.
- Gift payment reconciliation tasks may advance through worker states but cannot be deleted or truncated. They remain until a separately approved retention process exists.
- The order tables must contain only opaque address-vault references, never street address, phone, email, coordinates or delivery instructions. Account deletion/safety actions remove pre-dispatch address pointers and enqueue payment reconciliation without pretending a refund or void occurred.

## Migration ordering dependency

Deploy migrations 135–141 from PR #424 before merging and deploying PR #423's migration 134. Confirm `schema_migrations` contains `136_adjustment_and_l3_access_evidence.sql` before migration 134 is introduced to a deployment. The migration runner applies newly discovered files in filename order; if migrations 134 and 136 are both pending in the same deployment, 134 would run first and could cascade-delete historical L3 access events before their retention foreign keys are changed. Do not merge both PRs into one undeployed release.

## Operational requirements before production

1. Approve a jurisdiction-specific retention schedule with counsel for reports, moderation decisions, Paddle transaction references, gift/payment disputes, identity verification and audit records.
2. Define the legal-hold and dispute workflow before enabling any automated purge. A legal hold must override ordinary expiry.
3. Restrict database and audit-log access to authorized operational/moderation roles; protect backups and exports with encryption and access logging.
4. Monitor reconciliation queues and unresolved payment attempts. Never delete unresolved financial evidence to reduce storage.
5. If a retention schedule is later automated, use explicit per-record `retain_until` / legal-hold state, a dry-run report, bounded batches, and an immutable purge audit. Do not add a blanket cascade or age-only delete job.

No automated financial/report evidence purge is enabled by this change. That is deliberate until the retention periods and legal-hold rules are approved.
