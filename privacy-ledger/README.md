# Vow off-host privacy ledger

This is a separately deployable Cloudflare Worker + D1 service. It is intentionally not wired into the Vow API until its D1 database, HMAC secrets, pseudonym key, and deployment have been provisioned and tested.

## Local validation

```bash
node --test test/worker.test.js
```

## Provisioning

1. Create a Cloudflare account and a D1 database named `vow-privacy-ledger`.
2. Replace the placeholder `database_id` in `wrangler.toml`.
3. Apply `schema.sql` using Wrangler's D1 execute command against the intended environment.
4. Set `LEDGER_HMAC_SECRET` as a Worker secret (at least 32 random bytes encoded as a high-entropy string). Keep the Vow API's matching secret in its secret manager; never commit it.
5. Deploy the Worker and verify signed append, duplicate append, conflicting duplicate, authenticated pagination, and append-only trigger behaviour using synthetic events.
6. Configure a separately escrowed `PRIVACY_LEDGER_PSEUDONYM_KEY` in the Vow API. This is not the request-authentication key.
7. Only after the Vow API integration and isolated restore drill pass may the ledger be marked as a release prerequisite satisfied.

No account, D1 database, Worker, secret, DNS record, custom domain, scheduler, or Production resource is created by this repository scaffold. Do not use this ledger for real user events until API integration is complete.
