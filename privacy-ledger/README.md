# Vow off-host privacy ledger

This is a separately deployable Cloudflare Worker + D1 service. The Vow API already contains a signed append client and calls it from privacy-sensitive deletion/consent flows when configured. The Worker/D1 resource, secrets, and deployment are not provisioned, so the external ledger is not operational. In production, missing configuration intentionally makes those sensitive mutations fail closed.

## Local validation

```bash
node --test test/worker.test.js
```

## Provisioning

1. Create a Cloudflare account and a D1 database named `vow-privacy-ledger`.
2. Replace the placeholder `database_id` in `wrangler.toml`.
3. For a new D1 database, apply `schema.sql`. For an existing Ledger, apply `migrations/0002_gift_address_draft_consent_event.sql` and then `migrations/0003_snapshot_barrier.sql` exactly once before deploying the updated Worker; migration 0002 rebuilds the append-only event table while preserving all existing rows and sequence numbers.
4. Set `LEDGER_HMAC_SECRET` as a Worker secret (at least 32 random bytes encoded as a high-entropy string). Generate a separate Ed25519 key pair for barrier proofs; set the base64 PKCS#8 DER private key as Worker secret `LEDGER_PROOF_PRIVATE_KEY`, and give only the base64 SubjectPublicKeyInfo DER public key to the trusted backup runner as `PRIVACY_RECOVERY_LEDGER_PROOF_PUBLIC_KEY`. Keep both private/authentication secrets in their respective secret managers; never commit them.
5. Deploy the Worker and verify signed append, duplicate append, conflicting duplicate, authenticated pagination, snapshot barrier creation/release, append rejection while active, and append-only trigger behaviour using synthetic events.
6. Configure a separately escrowed `PRIVACY_LEDGER_PSEUDONYM_KEY` in the Vow API. This is not the request-authentication key.
7. Only after the Vow API integration and isolated restore drill pass may the ledger be marked as a release prerequisite satisfied.

No account, D1 database, Worker, secret, DNS record, custom domain, scheduler, or Production resource is created by this repository scaffold. The API append client is integrated, but do not use this ledger for real user events until the external Worker/D1 has been provisioned, synthetic-event checks pass, and the isolated restore/replay path is complete.


## Ledger snapshot append barrier

The Worker exposes authenticated `POST /v1/snapshot-barriers` and `POST /v1/snapshot-barriers/{barrier_id}/release` endpoints. Barrier creation accepts a caller-generated snapshot ID and UUIDv4 barrier ID, records the current maximum Ledger sequence, and returns an Ed25519-signed proof. Only one barrier can be active. Repeating the same create request while that barrier remains active returns the same boundary; reusing a released snapshot ID is rejected. Release is idempotent and returns a separately signed release receipt.

While a barrier is active, new `POST /v1/events` appends return HTTP 423 `snapshot_barrier_active`; idempotent duplicates of events already stored remain readable. Authenticated export pagination continues to work through the pinned sequence. The barrier row is append-only except for the single active-to-released transition; an abandoned active barrier remains active until an authenticated release, intentionally failing closed.

**This is only the remote Ledger half of a snapshot protocol.** It does not pause Vow API mutations, drain acknowledged-but-not-applied operations, pause the transactional outbox, stop media uploads/purge workers, or coordinate PostgreSQL and filesystem capture. A signed Ledger watermark alone is not an atomic database/media snapshot and must not be used to produce an activatable v3 backup. The Vow-side quiesce/drain protocol and an end-to-end synthetic backup/restore/replay drill are still required.


## Encrypted off-site export

After the Worker has been provisioned and synthetic-event checks pass, configure these values in a trusted backup runner (not in Git or the Vow app container):

- `PRIVACY_RECOVERY_LEDGER_URL`: HTTPS origin of the Worker (a `workers.dev` origin is sufficient; no custom Vow domain is needed).
- `PRIVACY_RECOVERY_LEDGER_HMAC_SECRET`: the same high-entropy request-authentication secret as the Worker.
- `PRIVACY_LEDGER_AGE_RECIPIENT`: an `age1...` public recipient; keep the private identity separately escrowed.
- `PRIVACY_LEDGER_BACKUP_DIR`: protected destination directory, preferably on a different provider/failure domain.

Run `npm run privacy-ledger:export`. The exporter authenticates every page, pins the first response's watermark for all subsequent pages, validates contiguous sequence numbers and event shape, and refuses incomplete, changing, or inconsistent pagination. It streams NDJSON directly to `age` stdin; plaintext event data is not written to a temporary file. The encrypted archive includes a small manifest and all events through the pinned watermark. A SHA-256 sidecar is created after encryption.

Copy both the `.ndjson.age` archive and its `.sha256` sidecar to immutable/offsite storage. Verify the ciphertext with `sha256sum --check` before retaining it. The exporter does not upload, schedule, provision, or configure any external storage. It creates a full-history export, not an incremental one; retain multiple verified generations according to the deletion-retention policy.

## Encrypted export verification

Before retaining or using an exported archive, verify its ciphertext checksum and decrypt/validate its contents in a controlled recovery environment. Keep the age identity in a separately escrowed secret file and set `PRIVACY_LEDGER_AGE_IDENTITY_FILE` only in the trusted runner:

```bash
npm run privacy-ledger:verify -- /secure/backups/vow-privacy-ledger-....ndjson.age
```

The verifier checks the sidecar against the archive bytes, rejects symlinks and malformed inputs, decrypts through the `age` process pipe without creating a plaintext temporary file, and validates the manifest, supported event types, event IDs, pseudonym references, timestamps, contiguous sequence numbers and declared event count. It prints only the verified archive path, checksum and sequence/count summary.

This is an integrity/decryption validation step, not a restore or replay engine. It does not connect to PostgreSQL, map pseudonymous references to restored records, mutate accounts/media/consent, or authorize reopening a restored environment. The hard recovery gate remains in force until a separate isolated, idempotent replay tool and end-to-end privacy restoration drill exist.

