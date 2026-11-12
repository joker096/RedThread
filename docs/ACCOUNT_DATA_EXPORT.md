# Vow account data export

## Endpoint

- Method and path: `POST /api/account/export`
- Authentication: active signed-in account session required.
- Origin: request-origin validation is enforced.
- Response: a versioned JSON attachment named `vow-data-export-YYYY-MM-DD.json`.
- Cache protection: responses include `Cache-Control: no-store, private` and `Pragma: no-cache`.
- Abuse protection: at most 3 export requests per client IP per rolling one-hour window. The limiter uses the shared PostgreSQL rate-limit store when the database is configured; the endpoint is not intended for automated bulk extraction.

Example:

```bash
curl --fail --silent --show-error \
  --request POST \
  --cookie 'nit_session=<your-session-cookie>' \
  --output vow-data-export.json \
  https://<configured-api-host>/api/account/export
```

Do not put session cookies in shell history, shared terminals, support tickets, or logs. The host above is a placeholder; configure the mobile API endpoint independently. Vow does not require a public web frontend.

## Export contents and privacy boundaries

The export is versioned as `vow-user-data-export` (version 1) and is scoped to the authenticated account. It includes the account's profile and preferences, relationship assessment, own likes/passes/blocks, matches and message history, notifications, media metadata, consent and moderation history, gift/order summaries, payment transaction summaries, and relevant partner/service/report records.

The export intentionally omits passwords, session/reset tokens, provider credentials and identifiers, payment secrets, private address-vault references, identity documents or biometric media, and private filesystem paths. Message bodies that have already been deleted are represented as unavailable.

**Media limitation:** profile-photo and voice-introduction records currently export metadata only. The actual photo/audio bytes are not bundled or exposed through this endpoint. A secure authenticated media-export flow is a separate implementation task.

## Client handling

Treat the downloaded JSON as sensitive personal data:
- Save it only to a private location controlled by the account owner.
- Do not upload it to analytics, support systems, public cloud folders, or issue trackers.
- Delete temporary copies after use and protect retained copies with device encryption.
- Validate the `format` and `version` fields before importing it into any future portability tool. Import is not currently supported.

## Release status

This endpoint is implemented for the current development branch. It is not a statement that Vow is production-ready. Production deployment, a configured domain, secure persistent media storage, tested off-site backups, retention/deletion operations, and formal operational review remain separate release gates. Paddle remains in Sandbox until written approval for Vow's intended use.
