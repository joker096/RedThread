# Financial and moderation evidence retention

This policy describes the data boundaries implemented in the repository. It does **not** assign legal retention periods. Those periods must be approved for each operating jurisdiction before production launch; the application must not silently invent a universal expiry.

## Paddle billing

- `paddle_webhook_events` stores only Paddle's event ID, event type and local processing timestamp. It does not store the signed request body, payment credentials, billing address or customer email.
- The event ledger is immutable. Do not delete deduplication IDs on a short rolling TTL: a delayed/manual provider redelivery must not be allowed to reapply a financial event. Any future compaction must preserve a durable replay barrier and be reviewed against Paddle's current redelivery/replay guarantees.
- `paddle_checkout_attempts` stores the current attempt for an account. When a terminal attempt is replaced by a new attempt, the previous attempt ID, transaction ID, plan, terminal status and timestamps are copied transactionally into `paddle_checkout_attempt_history`.
- Current and historical checkout records restrict hard deletion of the referenced user row. The supported account-erasure path is a tombstone, which preserves the minimum financial identity needed for reconciliation. It does not retain card data or full provider payloads.
- Do not purge attempts in `creating`, `pending`, `completed` or `reconciliation_required` states until the provider state and any refund/cancellation obligation have been reconciled. An outbox task is not proof that a provider action completed.

## Paddle adjustments and lifetime access

- Every `adjustment.created` and `adjustment.updated` event is retained as a minimal append-only record in `paddle_adjustment_events`, including event ID, adjustment ID, transaction ID, action, full/partial type, status and provider event time.
- Valid adjustments that cannot yet be matched to a unique Vow checkout are copied into `paddle_adjustment_reconciliation_cases` with a bounded reason code. The source adjustment remains immutable; the case stays open until a verified checkout/entitlement link resolves it or an authorized operator records a bounded resolution note. Query `WHERE status = 'open'` for the operational queue; never discard the case to clear an alert. Resolution records distinguish automatic checkout linkage from manual operator action and retain an opaque `resolved_by_ref` for manual decisions.
- A refund in `pending_approval` does not revoke Premium. A rejected refund also does not revoke it. Only an approved full refund revokes the lifetime entitlement tied to that exact transaction; partial refunds and credits do not automatically revoke the lifetime plan.
- A chargeback revokes the entitlement tied to its transaction. A chargeback reversal can restore it only when no other approved full refund or active chargeback remains for that transaction. Chargeback warnings are retained but do not by themselves revoke access.
- Lifetime entitlement provenance is stored by transaction ID in `paddle_lifetime_entitlements`. Reconciliation is scoped to the verified lifetime checkout attempt; unknown or ambiguous transactions are retained for manual reconciliation and never guessed.
- Reversal processing recomputes access from all verified lifetime purchases for the account, so an adjustment against one transaction does not revoke another independently valid lifetime purchase.


Operational queue query:

```sql
SELECT c.event_id, c.reason_code, e.adjustment_id, e.transaction_id, c.created_at
FROM paddle_adjustment_reconciliation_cases AS c
JOIN paddle_adjustment_events AS e USING (event_id)
WHERE c.status = 'open'
ORDER BY c.created_at ASC;
```

A manual resolution must set `status = 'resolved'`, a concise `resolution_note`, `resolution_source = 'manual_operator'`, and the operator's opaque UUID in `resolved_by_ref`. Automatic closure is reserved for a verified Vow checkout link and is marked `automatic_checkout_link`.

## L3 media access audit

- `identity_l3_media_access_events` retains opaque `submission_ref` and `moderator_ref` snapshots after the video and workflow submission are physically deleted.
- Live foreign keys are nullable and use `ON DELETE SET NULL`; only the nested FK action may clear them. Direct `UPDATE` and `DELETE` remain prohibited.
- The audit record contains no video bytes, storage path, IP address, or contact data. Its retention period must be set by the same jurisdiction-specific schedule and legal-hold process as other moderation evidence.

## User reports and moderation

- A report's reporter, target, category, submitted details and creation time are immutable. Moderation can move status from `open` to `reviewing`, `resolved` or `dismissed`, and from `reviewing` to a terminal status.
- Hard deletion of either account is restricted while a report references it. The normal account deletion workflow uses a deleted-account tombstone and therefore does not erase report evidence.
- `moderation_audit_log` is append-only. If a moderator account is physically removed through a separately approved retention operation, its FK reference may be nulled by PostgreSQL; the action record itself remains.
- Report details are user-supplied free text. The UI and moderator workflow must treat it as potentially sensitive and must not copy it into unrelated analytics, ad targeting, or general-purpose logs. The audit log should contain bounded reason codes and references, not the full report text.

## Gift and delivery evidence

- Gift purchase identity, product/price/currency snapshots and idempotency facts are immutable; order/payment lifecycle fields remain mutable through guarded transitions. Gift orders cannot be deleted or truncated.
- `gift_delivery_order_events` is append-only. Its `actor_ref` snapshot preserves the original actor UUID when the live `actor_user_id` FK is nulled after account deletion. Direct update/delete and truncation are blocked.
- Gift payment reconciliation tasks may advance through worker states but cannot be deleted or truncated. They remain until a separately approved retention process exists.
- The order tables must contain only opaque address-vault references, never street address, phone, email, coordinates or delivery instructions. Account deletion/safety actions remove pre-dispatch address pointers and enqueue payment reconciliation without pretending a refund or void occurred.

## Operational requirements before production

1. Approve a jurisdiction-specific retention schedule with counsel for reports, moderation decisions, Paddle transaction references, gift/payment disputes, identity verification and audit records.
2. Define the legal-hold and dispute workflow before enabling any automated purge. A legal hold must override ordinary expiry.
3. Restrict database and audit-log access to authorized operational/moderation roles; protect backups and exports with encryption and access logging.
4. Monitor reconciliation queues and unresolved payment attempts. Never delete unresolved financial evidence to reduce storage.
5. If a retention schedule is later automated, use explicit per-record `retain_until` / legal-hold state, a dry-run report, bounded batches, and an immutable purge audit. Do not add a blanket cascade or age-only delete job.

No automated financial/report evidence purge is enabled by this change. That is deliberate until the retention periods and legal-hold rules are approved.
