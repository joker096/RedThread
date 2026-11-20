# Temporary gift address drafts

## Security boundary

Temporary address drafts are a separate data class and storage boundary. They are never inserted into `gift_address_vault_entries`, never assigned to `gift_delivery_orders.address_vault_ref`, and never copied to order/event metadata. The draft API is recipient-only and accepts data only while the order is `recipient_accepted`, the recipient account and match are active, and no block/report/high-risk safety state exists.

Saving a draft requires a separate explicit, versioned consent (`GIFT_ADDRESS_DRAFT_CONSENT_VERSION=1`). Gift acceptance is not address-processing consent. Grant, withdrawal, and TTL expiry are recorded in an append-only, PII-free consent event table.

Drafts use AES-256-GCM with a dedicated keyring, separate from `GIFT_ADDRESS_VAULT_KEYRING`. Plaintext exists only in request/process memory for validation and encryption/decryption. The database stores nonce, authentication tag, ciphertext, key version and expiry only. Do not log request bodies or decrypted address values.

A draft is not address verification. There is no configured external address verifier in this workflow. The API explicitly returns `addressVerified: false` and `fulfilmentAuthorized: false`; the draft cannot transition an order to `address_verified` or authorize fulfilment.

## Configuration

Generate a dedicated 32-byte key for each version and encode it as standard base64. Keep the key outside the repository and outside database backups.

Example shape (replace the placeholder with a real randomly generated 32-byte key in the secret manager):

```dotenv
GIFT_ADDRESS_DRAFT_KEYRING={"draft-v1":"REPLACE_WITH_BASE64_32_BYTE_SECRET"}
GIFT_ADDRESS_DRAFT_ACTIVE_KEY_VERSION=draft-v1
GIFT_ADDRESS_DRAFT_PURGE_BATCH_SIZE=100
```

Do not reuse `GIFT_ADDRESS_VAULT_KEY`, voice, identity, session, or backup encryption keys. Missing/invalid keyring configuration fails closed: create/read endpoints return 503.

## API

- `PUT /api/gifts/orders/:publicReference/address-draft`: recipient-only; requires `{ "consent": true, "consentVersion": 1, "address": { ... } }`. Stores or replaces an encrypted temporary draft.
- `GET /api/gifts/orders/:publicReference/address-draft`: recipient-only; returns the decrypted draft only while consent is active and TTL has not elapsed.
- `DELETE /api/gifts/orders/:publicReference/address-draft`: recipient-only; captures the active consent-grant event, obtains a durable ACK for `gift_address_draft_consent_withdrawn`, then reacquires safety/order/consent locks, revalidates the same grant lifecycle, physically deletes the live ciphertext row and appends the local withdrawal event atomically. Ledger failure returns 503 and leaves the ciphertext and consent unchanged. The same deterministic event ID is reused on retries.

The order must already be `recipient_accepted`. A transition out of that state, order-level consent withdrawal, account suspension/deletion, match deactivation, block/report/safety hold or other terminalization automatically deletes the draft row and withdraws active draft consent.

## TTL and deletion

The database rejects a TTL greater than 24 hours. Run `npm run gifts:address-drafts:purge` from a private scheduler at least every five minutes. The command deletes expired ciphertext rows in bounded batches using `FOR UPDATE SKIP LOCKED`, then appends the non-PII `expired` consent event in the same transaction. On failure the transaction rolls back and the next scheduled run retries.

The read-only `npm run ops:health` report includes the `gift_address_draft_ttl` backlog so delayed purges can be alerted. A non-zero expired backlog indicates the scheduler is not keeping up.

A PostgreSQL `DELETE` removes the live row transactionally; PostgreSQL MVCC, WAL and encrypted backups may retain old ciphertext pages until normal vacuum and configured WAL/backup retention expire. This is not a claim of forensic overwrite of SSD blocks or immediate erasure from historical backups. Keep encrypted backup/WAL retention bounded and documented. Do not enable this workflow in Production until the dedicated key is escrowed and the private purge scheduler/alerting are configured and tested.

No scheduler is activated by this change. No Production environment, payment provider, external address verifier, domain or VPS service is enabled.
