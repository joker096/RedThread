-- A granted consent must be attributable to the recipient. CHECK expressions
-- evaluating to UNKNOWN are accepted by PostgreSQL, so require actor_user_id explicitly.
ALTER TABLE gift_address_draft_consent_events
  ADD CONSTRAINT gift_address_draft_consent_grant_actor_required_check
  CHECK (
    action <> 'granted'
    OR (actor_user_id IS NOT NULL AND actor_user_id = recipient_user_id)
  );
