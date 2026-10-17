# Vow deployment runbook

## Honest status

The repository can now be built as a containerized web/API/PostgreSQL stack. Adding these files does **not** deploy a public preview or make Vow production-ready. No hosting account, domain, TLS certificate, provider credentials, backup destination, or production database was provisioned from this repository session.

## Local container preview

Requirements: Docker Engine and the Docker Compose plugin.

1. Create a deployment `.env` file with at least:
   ```dotenv
   POSTGRES_DB=vow_app
   POSTGRES_USER=vow_user
   POSTGRES_PASSWORD=replace-with-a-long-random-hex-secret
   APP_ORIGIN=http://localhost:8080
   APP_URL=http://localhost:8080
   WEB_BIND=127.0.0.1:8080
   EMAIL_VERIFICATION_REQUIRED=false # local preview only if email provider is not configured
   ```
2. Generate a URL-safe database password (for example, `openssl rand -hex 32`). Do not commit `.env` or paste secrets into issues/chat.
3. Start the stack: `docker compose up --build -d`.
4. Open `http://localhost:8080`. Check `docker compose ps`, `docker compose logs --tail=100 api`, and `curl -fsS http://localhost:8080/api/health`.
5. Stop it with `docker compose down`. Persistent database and private-photo volumes remain. To destroy local data explicitly, `docker compose down -v` (destructive).

The first start builds the API and web image, waits for PostgreSQL health, applies migrations once through the one-shot `migrate` service, and then starts the API and web proxy. For local-only testing without a configured Resend sender, you may set `EMAIL_VERIFICATION_REQUIRED=false`; never disable verification on a public deployment. The database is not published to the host. The default web binding is loopback-only.

## Public hosting requirements

Do not expose this Compose stack directly to the internet over plain HTTP. Put a maintained TLS reverse proxy/load balancer in front of the web service, bind the service only to a private interface, and set `APP_ORIGIN` and `APP_URL` to the exact public HTTPS origin. Configure forwarded-header trust only for the known proxy topology; do not blindly trust arbitrary client-supplied forwarding headers.

Before public launch:
- Provision a supported host, DNS, TLS, and monitoring; set resource limits and update policies.
- Use a managed PostgreSQL service or a protected private database network. Enable TLS verification when required by the provider.
- Use a secret manager for database, Resend, and Stripe secrets. Do not commit credentials.
- Configure a verified sender domain and test email verification, resend and password reset end-to-end.
- Configure Stripe products/prices and webhook signing secret; test checkout, renewals, cancellations, refunds and webhook replay behavior in test mode first.
- Set a persistent private photo volume or private object storage; test photo review, access control, restore and deletion.
- Schedule encrypted off-host database and photo backups; test restore. See [backup runbook](./OPERATIONS_BACKUPS.md).
- Decide abuse-response staffing, moderator access, incident response, data retention, account export/deletion, age/identity checks, privacy notice and jurisdiction-specific terms.
- Run dependency, container and secret scans; perform external security review and native-speaker review of safety/legal/payment copy.
- Test Android/PWA install, mobile layouts, keyboard navigation, screen readers, RTL layout and poor-network/error states.

## Deployment caveats

- The language selector lists many locales but most languages are not fully translated. Do not advertise all languages as fully supported.
- Local AI moderation is optional and disabled by default. If enabled, install the model on the same trusted host and keep its service bound to loopback; evaluate false positives/negatives and retain human review.
- The current discovery and chat UI includes demo data/features. Clearly separate them from registered-user data in any public demo; never use demo conversations as real user activity.
- Do not enable live billing until payment, cancellation, refund and consumer-disclosure flows have been verified.
- This runbook is an implementation guide, not a compliance certification or guarantee of security.


## Release acceptance gates (must be evidenced, not assumed)

Keep this list with the release candidate. A checked item means the named evidence exists for the exact candidate commit; a green build alone is not evidence that a provider or user journey works.

### Gate A — build and container smoke test
- [ ] CI passed on the exact release commit: database migrations, TypeScript lint, automated tests, production web build, Compose validation, API image build, and web image build.
- [ ] On a clean host, `docker compose up --build -d` reaches healthy states for `db`, `api`, and `web`; the one-shot `migrate` service exits successfully.
- [ ] `curl -fsS http://localhost:8080/api/health` succeeds through the web proxy.
- [ ] Restart the stack and confirm test account/profile data remains; confirm the database is not listening on a public host port.
- [ ] Confirm the deployment has no committed or baked-in `.env` values, and inspect the effective Compose configuration without publishing its secret output.

### Gate B — account and privacy journeys
- [ ] With email delivery enabled, register, receive and use a verification link, request another link, and verify expired/reused links are rejected.
- [ ] Complete password reset; verify the reset token is one-time and all previous sessions become invalid.
- [ ] Verify unauthenticated, unverified and cross-account requests cannot read private photos or another account's data.
- [ ] Verify profile deletion, session revocation, data export/deletion behavior and the documented retention policy against a staging database.
- [ ] Confirm block/report flows prevent unwanted discovery and messages and route reports to an authorized human moderator.

### Gate C — safety, media and localization
- [ ] Upload valid, corrupt, oversized and unsupported images; verify normalization removes metadata and private images are only served to authorized viewers.
- [ ] Verify the default photo moderation state is pending when automated moderation is disabled or unavailable; uncertain results go to human review.
- [ ] Exercise the complete signup, discovery, compatibility, chat, safety, error and email copy in each language claimed as supported.
- [ ] Verify RTL layout for Arabic, Hebrew, Persian and Urdu, including dialogs, forms, navigation and swipe controls.
- [ ] Test mobile viewport, keyboard-only operation, screen-reader labels, reduced motion and slow/offline network behavior.

### Gate D — payments and operational recovery
- [ ] Keep billing disabled until Stripe test-mode checkout, signed webhook verification, duplicate/replayed events, cancellation, failed payment and refund flows pass.
- [ ] Confirm Premium entitlements are derived server-side and cannot be granted by changing client state.
- [ ] Configure encrypted off-host backups for PostgreSQL and private photos; run and record a restore drill in an isolated staging environment.
- [ ] Configure uptime/error alerts, log redaction, incident contacts, retention and access controls for operators/moderators.
- [ ] Complete dependency/container/secret scans and an independent security review; resolve or explicitly risk-accept every high/critical finding.

### Gate E — legal and launch decision
- [ ] Publish reviewed terms, privacy notice, cookie/analytics disclosures where applicable, community rules, reporting/appeal process and account deletion instructions.
- [ ] Confirm age restrictions, identity-verification approach, moderation staffing and jurisdiction-specific obligations with qualified counsel for each launch market.
- [ ] Run a limited beta with documented consent, support contact, rollback plan and a tested process for pausing registration or payments.
- [ ] Obtain a release decision from the responsible operator after reviewing the evidence above.

## Local smoke-test commands

Run from the repository root after starting the stack:

```bash
docker compose ps
docker compose logs --tail=100 db migrate api web
curl -fsS http://localhost:8080/api/health
docker compose config --quiet
```

Do not paste the rendered output of `docker compose config` into public issues or chat: environment expansion can expose credentials. If a check fails, retain sanitized logs and the candidate commit SHA for diagnosis.

### Gate F — sponsored placement operations

- [ ] If first-party ad event logging is enabled, configure the deployment scheduler to run `npm run ads:cleanup-events` at least once every 24 hours with the production `DATABASE_URL`; set `PGSSL=true` when required by the database provider.
- [ ] Run the cleanup command once in staging, verify it exits successfully, and confirm only records older than 90 days are removed in bounded batches. Verify the scheduler's next run and alert on non-zero exit status or missed runs.
- [ ] Verify a configured campaign records an impression only after an eligible non-premium authenticated session sees the placement; verify click logging is attempted only after the server accepts the impression.
- [ ] Verify a demo sponsor without a server campaign ID creates no server ad events, premium sessions create no events, and rate/frequency caps are enforced.
- [ ] Keep first-party app events separate from billable ad-provider reporting. Do not use these records as proof of valid provider impressions, clicks, invoices, or revenue.
- [ ] Before selling placements, connect and test the provider's approved reporting/postback mechanism, document consent and privacy disclosures, and reconcile sample reports against the provider's authoritative dashboard.
- [ ] If no campaign provider or scheduled cleanup is configured, document both as launch blockers; do not describe ad monetization as production-ready.

