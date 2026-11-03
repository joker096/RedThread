# Deleted-account profile data erasure

When an account transitions to `users.status = 'deleted'`, profile-derived personal data must be scrubbed at the database boundary, not only by the HTTP handler. The scrub covers birth date, gender, location, biography, photo URLs, occupation, education, languages, relationship intent, child and family disclosures, family values, and visibility.

A minimal non-discoverable profile tombstone remains for relational integrity. Restricted billing, safety, moderation, and fraud-prevention records may require limited retention for payment reconciliation, disputes, or legal obligations. Define jurisdiction-specific retention periods and access controls before production launch; this document is not a legal determination that records may be kept indefinitely.
