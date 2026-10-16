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
