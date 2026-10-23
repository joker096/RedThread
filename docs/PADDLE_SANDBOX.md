# RevenueCat Web Billing + Paddle Sandbox

Russian seller onboarding, Georgia payout notes, KYC, tax form caveats, and Paddle product-policy checks: [PADDLE_REVENUECAT_ONBOARDING_RU.md](PADDLE_REVENUECAT_ONBOARDING_RU.md).

Vow's browser subscription panel uses RevenueCat Web Billing, with Paddle Billing as its payment provider. RevenueCat sends webhooks to Vow; the server checks the current Premium entitlement against RevenueCat before enabling paid features. The old direct Paddle Sandbox integration remains available for backwards compatibility.

**The integration is sandbox-only until the purchase lifecycle has been verified.** Do not enable live billing as part of initial setup.

## 1. Create the sandbox catalog

1. Create or select the RevenueCat project for Vow, then enable its Paddle Billing integration and connect the Paddle Sandbox account.
2. In Paddle Sandbox, create the products and recurring prices you intend to offer. Do not copy the example prices from informal setup notes without deciding your actual offer and reviewing local requirements.
3. In RevenueCat, import/sync the Paddle catalog. Create one entitlement named `premium_access` (or choose another ID and set `REVENUECAT_PREMIUM_ENTITLEMENT_ID` accordingly).
4. Create a RevenueCat Offering and add the intended monthly/quarterly packages. Attach every package that unlocks the same Premium feature set to `premium_access`. The app displays the Offering's products and prices returned by RevenueCat; it does not hardcode prices.
5. Use RevenueCat's public Web Billing API key with the `rcb_` prefix. Keep RevenueCat secret API keys on the server.

A single entitlement is used by the current Vow Premium access gate. Distinct tiers require implementation of distinct capabilities before they should be sold as separate tiers.

## 2. Configure the server

Set these environment variables in the API deployment's secret store:

- `REVENUECAT_WEB_API_KEY`: public Web Billing key beginning with `rcb_`. It is returned only to authenticated clients.
- `REVENUECAT_SECRET_API_KEY`: RevenueCat secret API key used for server-side subscriber lookups.
- `REVENUECAT_WEBHOOK_AUTHORIZATION`: a high-entropy value for the webhook's HTTP Authorization header.
- `REVENUECAT_PREMIUM_ENTITLEMENT_ID=premium_access`
- `REVENUECAT_ENVIRONMENT=sandbox`

Configure a RevenueCat webhook destination at:

`https://YOUR_API_HOST/api/revenuecat/webhook`

Set the destination Authorization header to the exact value of `REVENUECAT_WEBHOOK_AUTHORIZATION`. Subscribe to purchase, renewal, cancellation, uncancellation, expiration, billing issue, product change, pause, refund, and transfer events. Send RevenueCat's test event and confirm the endpoint returns HTTP 200. The server accepts only the configured environment and verifies webhook authorization before querying RevenueCat's subscriber API. Event IDs are recorded idempotently; paid access is based on the current `premium_access` entitlement, not on a client redirect or webhook payload alone.

Run the existing database migration command after deploying the code:

```sh
npm run db:migrate
```

This applies `101_revenuecat_entitlements.sql`. The API's `/api/billing/status` response should report `paymentConfigured: true` only after the required RevenueCat environment is present.

## 3. Verify the sandbox flow

1. Use an eligible test account in Vow and open Account. The current offer packages and localized prices should load from RevenueCat.
2. Complete a Paddle Sandbox purchase and confirm that the Paddle transaction appears in its sandbox dashboard.
3. Confirm RevenueCat receives the purchase and delivers its webhook to the Vow API.
4. Confirm `/api/billing/status` changes to `access: "full"` only after the server processes the event.
5. Test renewal, cancellation at period end, expiration, billing issue, refund, duplicate delivery, and out-of-order delivery. Confirm access remains only while RevenueCat reports the configured entitlement as active.
6. Try a second account and verify that one user's purchase does not unlock Premium for another account.

Never use real card details in Sandbox. The app never treats returning from checkout as proof of payment.

## 4. Existing direct Paddle Sandbox configuration

The old direct Paddle checkout remains gated to `PADDLE_ENVIRONMENT=sandbox` and a client token beginning with `test_`. It uses `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, and the existing `PADDLE_PRICE_ID_*` values. New RevenueCat-based checkout does not require those direct-checkout variables. Avoid presenting both checkout paths to users at the same time.

## Account, tax, and app-store setup

Paddle determines the identity and tax documents required during seller onboarding. Complete the process in Paddle's own dashboard using the information and documents it requests; requirements depend on the seller and jurisdiction. Do not put passport, bank, tax, or API credentials in Git or chat. Confirm supported payout currency and bank fees directly with Paddle and your bank before relying on a particular receiving currency.

Vow is currently a web application. If native iOS or Android purchase flows are added later, implement the platform's required in-app billing path and configure its store products with RevenueCat. Availability of web purchase links and external purchase options depends on current store rules and user storefront; do not assume that a Paddle web checkout can replace store billing in every country.

## References

- [RevenueCat Paddle Billing integration](https://www.revenuecat.com/docs/web/integrations/paddle)
- [RevenueCat Web SDK](https://www.revenuecat.com/docs/web/web-billing/web-sdk)
- [RevenueCat webhooks](https://www.revenuecat.com/docs/integrations/webhooks)
- [Paddle Sandbox](https://developer.paddle.com/sdks/sandbox/)
- [Apple App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Google Play payments policy](https://support.google.com/googleplay/android-developer/answer/10281818?hl=en)

