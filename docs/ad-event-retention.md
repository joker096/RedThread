# Ad event privacy and retention

Vow records a minimal first-party engagement event only for an authenticated, non-premium session and a configured campaign. Events contain a client-generated event UUID, the account ID, a campaign slug, an event type (`impression` or `click`), and a server timestamp. Do not put names, email addresses, profile text, precise location, or other personal data in campaign IDs or event payloads.

## Retention

- First-party ad engagement events are retained for no more than **90 days** for frequency control and operational diagnostics.
- The `user_id` foreign key uses `ON DELETE CASCADE`, so deleting an account also deletes that account's event records.
- A database migration adds an index for bounded age-based deletion.
- Run `npm run ads:cleanup-events` at least daily using the deployment platform's scheduler/cron facility. The job is safe to rerun and deletes in batches. Configure `DATABASE_URL` and, where applicable, `PGSSL=true`. Optional `AD_EVENT_CLEANUP_BATCH_SIZE` defaults to 1000 and is limited to 5000.
- Monitor scheduler exit status and logs. A successful deploy does not itself schedule this command; operators must configure the scheduled job in the target environment.

## Reporting and billing boundaries

These rows are internal app events used for frequency control. They are **not** verified provider impressions, valid clicks, ad-network reports, or proof of revenue. Do not calculate invoices or represent revenue from these rows alone. Before live monetization, integrate a provider's supported reporting/postback mechanism and reconcile against that provider's authoritative reports.

## User disclosure

Sponsored placements must remain visibly identified as sponsored/advertising in every supported locale. Keep the sponsor disclosure adjacent to the placement, not hidden only in terms or tooltips. Premium accounts should not receive sponsored placements or generate ad engagement events. If an analytics request fails, core discovery and navigation must continue working.
