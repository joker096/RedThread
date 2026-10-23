# Paddle Sandbox integration

This integration is intentionally locked to Paddle Sandbox. It does not switch production to live and does not enable real charges.

## Required sandbox configuration

Copy these into the server's secret environment (never commit actual values):

- `PADDLE_ENVIRONMENT=sandbox`
- `PADDLE_API_KEY`: sandbox API key with permission to create transactions.
- `PADDLE_WEBHOOK_SECRET`: signing secret from a sandbox notification destination pointing to `https://YOUR_PUBLIC_SANDBOX_HOST/api/paddle/webhook`.
- `PADDLE_CLIENT_TOKEN`: sandbox client-side token beginning with `test_`.
- `PADDLE_PRICE_ID_1MONTH`, `PADDLE_PRICE_ID_3MONTHS`, and optionally `PADDLE_PRICE_ID_LIFETIME`: sandbox price IDs beginning with `pri_`.

The server refuses checkout unless `PADDLE_ENVIRONMENT=sandbox` and the client token begins with `test_`. Server API calls use `https://sandbox-api.paddle.com` only. Do not add the API key or webhook secret to client-side variables.

## Dashboard tasks

1. In the Paddle **Sandbox** account, create the Vow Premium products/prices that match the current Vow offer and put their price IDs into the environment variables above. The current code accepts monthly, three-month, and optional lifetime price IDs; a lifetime option is a one-time purchase, not a recurring subscription.
2. Create a sandbox notification destination for `/api/paddle/webhook`; subscribe to `subscription.created`, `subscription.updated`, `subscription.canceled`, `customer.created`, `customer.updated`, and `transaction.completed`. Copy its notification signing secret into `PADDLE_WEBHOOK_SECRET`.
3. Configure the sandbox default payment link under Checkout > Checkout configuration to a page on your own domain. Do not use localhost for the Paddle default payment link.
4. Run `npm run db:migrate`, restart the API, and sign in with an eligible female test account. The account panel displays Paddle Sandbox checkout only after configuration.
5. Use Paddle's sandbox successful test card `4242 4242 4242 4242` with any future expiry date; also test declined card `4000 0000 0000 0002`. Verify the overlay, completed transaction, webhook 2xx delivery, and database state. Do not use real card data.
6. Exercise an upgrade with `do_not_bill`, a scheduled cancellation effective at `next_billing_period`, and an immediate cancellation. Confirm scheduled cancellation preserves access through the current period and immediate cancellation removes it.

## Current safety boundaries

- Webhook signature verification uses the Paddle Node SDK and the notification signing secret against the raw request body.
- Event IDs are stored in `paddle_webhook_events` in the same transaction as entitlement updates, so retries are idempotent.
- `transaction.completed` alone does not grant Premium; a verified active/trialing subscription event with a future billing-period end does.
- The checkout transaction is created server-side and includes the authenticated internal user ID in server-generated custom data; the client cannot choose a price ID or user ID.
- The code intentionally rejects live environment configuration. Do not switch to live until sandbox tests pass and the Paddle account/domain verification is complete.

## Not yet verified

The repository change can prepare the integration, but it cannot create products, API keys, tokens, or notification destinations without access to your Paddle Sandbox account. After setting the sandbox secrets and creating the catalog, verify deliveries under Paddle **Events > Notifications**. Never paste API keys or signing secrets into chat or Git.
