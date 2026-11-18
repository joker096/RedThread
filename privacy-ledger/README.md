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
4. Generate the Ed25519 proof key pair in a trusted key-management environment (not in the repository):

   ```bash
   openssl genpkey -algorithm ED25519 -out ledger-proof-private.pem
   openssl pkey -in ledger-proof-private.pem -outform DER | base64 -w0 > ledger-proof-private.pkcs8.b64
   openssl pkey -in ledger-proof-private.pem -pubout -outform DER | base64 -w0 > ledger-proof-public.spki.b64
   ```

5. Set `LEDGER_HMAC_SECRET` and the base64 PKCS#8 DER private key as Worker secrets (`LEDGER_PROOF_PRIVATE_KEY`). Store only the base64 SubjectPublicKeyInfo DER public key as `PRIVACY_RECOVERY_LEDGER_PROOF_PUBLIC_KEY` in the trusted backup runner. Keep the private key and authentication secret in their respective secret managers; never commit them.
6. Deploy the Worker and verify signed append, duplicate append, conflicting duplicate, authenticated pagination, snapshot barrier creation/release, append rejection while active, and append-only trigger behaviour using synthetic events.
7. Configure a separately escrowed `PRIVACY_LEDGER_PSEUDONYM_KEY` in the Vow API. This is not the request-authentication key.
8. Only after the Vow API integration and isolated restore drill pass may the ledger be marked as a release prerequisite satisfied.

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

