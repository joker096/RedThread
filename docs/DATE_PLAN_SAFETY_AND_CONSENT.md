# Mutual date plan safety and consent

Vow date plans are available only inside an active server match. They are not a booking, payment, advertising, gift, or delivery authorization.

## Consent model

- Either participant may propose a public venue label, a date/time, and an IANA time-zone identifier.
- The client sends an explicit UTC-offset timestamp; ambiguous local wall-clock timestamps are rejected.
- Both participants must independently confirm the same saved proposal. The proposer is not treated as having consented merely by proposing.
- A proposal update replaces the venue/time and clears both confirmation timestamps. Both people must confirm the revised proposal again.
- A plan becomes confirmed only when both confirmation timestamps are present in the same PostgreSQL row.
- Either participant may decline a pending proposal. Proposals expire when their scheduled time passes.
- Blocking either participant, closing the match, deactivating an account, losing live L2 verification, revoking L3 approval, or withdrawing current L3 consent automatically cancels an open or confirmed plan. If an L3 approval expires without a provider event, the next date-plan access detects the lost eligibility and cancels the plan. A later re-verification never revives old confirmations; both people must propose and confirm again.
- L2 verification rows are locked while date-plan eligibility is checked, so a concurrent Didit revocation cannot race a new proposal or confirmation. Database triggers cancel plans in the same transaction as explicit account/identity gate changes.

## Privacy and safety boundaries

- Store only a short venue name, scheduled instant, and time-zone identifier. Do not collect home addresses, phone numbers, private contact details, or recipient delivery coordinates.
- The venue field is a user-supplied label plus a public-place attestation; Vow does not claim to independently verify that a venue is public or safe. Users should choose a staffed, public location and arrange their own transport.
- Date-plan reads and writes re-check match membership, both active accounts, identity interaction eligibility, and either-direction blocks after acquiring the shared account-safety locks.
- Writes are serialized by the match row lock and a partial unique index permits at most one proposed/confirmed plan per match.
- Confirmation and proposal events are stored in an audit history table. Notifications are created in the same transaction as the corresponding state change.
- The API rate-limits plan changes and rejects times less than 30 minutes away or more than 90 days away.

## Operational limitations

The feature does not reserve a table, verify venue opening hours, share a live location, contact either participant outside Vow, or trigger contextual advertising. Contextual date offers remain governed by the separate advertising-consent policy and must not be inferred from a proposal or from a one-sided confirmation.
