# Provider application flow

Service providers (for example cafés, photographers, venues, legal professionals and beauty specialists) can submit a business listing for review from the services marketplace.

## Current behavior

- The application is stored server-side with a pending review status; the browser never treats local form validation as a submitted listing.
- The intake collects business contact details, service category, location, a short service description, and optional HTTPS website/public registry links.
- An application is not a public listing and does not imply identity, license, safety, price, or quality verification.
- The database rejects duplicate open applications for the same normalized email and category.
- The API checks Origin, applies a server-side rate limit, validates all fields, and requires explicit consent.
- Do not submit passport scans, identity documents, bank details, payment information, or private credentials. Document review and provider accounts are not enabled by this intake.
- Application review and publication remain a manual operator step. Until a provider verification workflow is implemented, demo cards remain clearly labeled.

Before production launch, add an authenticated moderation queue, documented retention/deletion rules, and an approved provider-publication process. Avoid claiming verification until evidence has been reviewed by an authorized person.
