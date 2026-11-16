-- Temporary recipient-entered gift address drafts are isolated from the verified-address Vault.
-- This table is never referenced by gift_delivery_orders.address_vault_ref and can never
-- satisfy the address_verified / fulfilment constraints.
CREATE TABLE IF NOT EXISTS gift_address_draft_consent_events (
  id BIGSERIAL PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES gift_delivery_orders(id) ON DELETE RESTRICT,
  recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  consent_version INTEGER NOT NULL CHECK (consent_version > 0),
  action TEXT NOT NULL CHECK (action IN ('granted', 'withdrawn', 'expired')),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CHECK ((action = 'granted' AND actor_user_id = recipient_user_id)
      OR (action IN ('withdrawn', 'expired')))
);

CREATE INDEX IF NOT EXISTS gift_address_draft_consent_latest_idx
  ON gift_address_draft_consent_events (order_id, recipient_user_id, id DESC);

CREATE TABLE IF NOT EXISTS gift_address_drafts (
  order_id UUID PRIMARY KEY REFERENCES gift_delivery_orders(id) ON DELETE CASCADE,
  recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  key_version VARCHAR(32) NOT NULL CHECK (key_version ~ '^[A-Za-z0-9._-]{1,32}$'),
  nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
  auth_tag BYTEA NOT NULL CHECK (octet_length(auth_tag) = 16),
  ciphertext BYTEA NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 16384),
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + INTERVAL '24 hours')
);

CREATE INDEX IF NOT EXISTS gift_address_drafts_expiry_idx
  ON gift_address_drafts (expires_at, order_id);

CREATE OR REPLACE FUNCTION reject_gift_address_draft_consent_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $draft_consent_immutable$
BEGIN
  RAISE EXCEPTION 'gift address draft consent history is append-only'
    USING ERRCODE = '23514';
END;
$draft_consent_immutable$;

DROP TRIGGER IF EXISTS gift_address_draft_consent_events_immutable ON gift_address_draft_consent_events;
CREATE TRIGGER gift_address_draft_consent_events_immutable
  BEFORE UPDATE OR DELETE ON gift_address_draft_consent_events
  FOR EACH ROW EXECUTE FUNCTION reject_gift_address_draft_consent_event_mutation();

CREATE OR REPLACE FUNCTION enforce_gift_address_draft_scope()
RETURNS trigger LANGUAGE plpgsql AS $draft_scope$
DECLARE
  order_row RECORD;
  consent_row RECORD;
BEGIN
  SELECT sender_id, recipient_id, match_id, status, consent_withdrawn_at, expires_at
    INTO order_row
    FROM gift_delivery_orders
   WHERE id = NEW.order_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'gift address draft order does not exist'
      USING ERRCODE = '23514';
  END IF;

  SELECT action, consent_version
    INTO consent_row
    FROM gift_address_draft_consent_events
   WHERE order_id = NEW.order_id
     AND recipient_user_id = NEW.recipient_user_id
   ORDER BY id DESC
   LIMIT 1;

  IF NOT FOUND
     OR order_row.recipient_id <> NEW.recipient_user_id
     OR order_row.status <> 'recipient_accepted'
     OR order_row.consent_withdrawn_at IS NOT NULL
     OR order_row.expires_at <= statement_timestamp()
     OR consent_row.action <> 'granted'
     OR consent_row.consent_version <> 1
     OR NOT EXISTS (
       SELECT 1 FROM users
        WHERE id = order_row.sender_id AND status = 'active'
     )
     OR NOT EXISTS (
       SELECT 1 FROM users
        WHERE id = order_row.recipient_id AND status = 'active'
     )
     OR NOT EXISTS (
       SELECT 1 FROM matches
        WHERE id = order_row.match_id AND status = 'active'
     )
     OR EXISTS (
       SELECT 1 FROM user_blocks
        WHERE (blocker_id = order_row.sender_id AND blocked_id = order_row.recipient_id)
           OR (blocker_id = order_row.recipient_id AND blocked_id = order_row.sender_id)
     )
     OR EXISTS (
       SELECT 1 FROM user_reports
        WHERE status IN ('open', 'reviewing')
          AND ((reporter_id = order_row.sender_id AND reported_user_id = order_row.recipient_id)
            OR (reporter_id = order_row.recipient_id AND reported_user_id = order_row.sender_id))
     )
     OR EXISTS (
       SELECT 1 FROM user_safety_screenings
        WHERE user_id IN (order_row.sender_id, order_row.recipient_id)
          AND severity = 'high'
          AND review_status IN ('pending', 'reviewing', 'actioned')
     ) THEN
    RAISE EXCEPTION 'gift address draft is not authorized'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$draft_scope$;

DROP TRIGGER IF EXISTS gift_address_draft_scope_guard ON gift_address_drafts;
CREATE TRIGGER gift_address_draft_scope_guard
  BEFORE INSERT OR UPDATE ON gift_address_drafts
  FOR EACH ROW EXECUTE FUNCTION enforce_gift_address_draft_scope();

COMMENT ON TABLE gift_address_drafts IS
  'Separate AES-256-GCM encrypted temporary address drafts. Never referenced by address_vault_ref; never proves address verification or authorizes fulfilment. Physical deletion is required on withdrawal and by the TTL purge worker.';
COMMENT ON TABLE gift_address_draft_consent_events IS
  'Append-only, versioned recipient consent history for temporary gift-address processing. Separate from gift acceptance and the verified-address Vault.';

-- Any transition out of recipient_accepted destroys the temporary payload and
-- revokes the draft-processing consent. The event contains no address data.
CREATE OR REPLACE FUNCTION purge_gift_address_draft_on_order_safety_transition()
RETURNS trigger LANGUAGE plpgsql AS $draft_order_cleanup$
DECLARE
  removed RECORD;
BEGIN
  IF (NEW.status IS DISTINCT FROM OLD.status OR
      NEW.consent_withdrawn_at IS DISTINCT FROM OLD.consent_withdrawn_at)
     AND (NEW.status <> 'recipient_accepted' OR NEW.consent_withdrawn_at IS NOT NULL) THEN
    FOR removed IN
      DELETE FROM gift_address_drafts
       WHERE order_id = NEW.id
       RETURNING order_id, recipient_user_id
    LOOP
      INSERT INTO gift_address_draft_consent_events
        (order_id, recipient_user_id, consent_version, action, actor_user_id)
      SELECT removed.order_id, removed.recipient_user_id,
             COALESCE((
               SELECT consent_version FROM gift_address_draft_consent_events
                WHERE order_id = removed.order_id
                  AND recipient_user_id = removed.recipient_user_id
                ORDER BY id DESC LIMIT 1
             ), 1),
             'withdrawn', NULL
      WHERE EXISTS (
        SELECT 1 FROM gift_address_draft_consent_events
         WHERE order_id = removed.order_id
           AND recipient_user_id = removed.recipient_user_id
           AND action = 'granted'
         ORDER BY id DESC LIMIT 1
      )
      AND (
        SELECT action FROM gift_address_draft_consent_events
         WHERE order_id = removed.order_id
           AND recipient_user_id = removed.recipient_user_id
         ORDER BY id DESC LIMIT 1
      ) = 'granted';
    END LOOP;
  END IF;
  RETURN NEW;
END;
$draft_order_cleanup$;

DROP TRIGGER IF EXISTS gift_orders_purge_temporary_address_draft ON gift_delivery_orders;
CREATE TRIGGER gift_orders_purge_temporary_address_draft
  AFTER UPDATE OF status, consent_withdrawn_at ON gift_delivery_orders
  FOR EACH ROW EXECUTE FUNCTION purge_gift_address_draft_on_order_safety_transition();

CREATE OR REPLACE FUNCTION purge_inactive_account_gift_address_drafts()
RETURNS trigger LANGUAGE plpgsql AS $draft_account_cleanup$
DECLARE
  removed RECORD;
BEGIN
  IF NEW.status <> 'active' AND OLD.status = 'active' THEN
    FOR removed IN
      DELETE FROM gift_address_drafts d
       USING gift_delivery_orders o
       WHERE d.order_id = o.id
         AND (o.sender_id = NEW.id OR o.recipient_id = NEW.id)
       RETURNING d.order_id, d.recipient_user_id
    LOOP
      IF (
        SELECT action FROM gift_address_draft_consent_events
         WHERE order_id = removed.order_id
           AND recipient_user_id = removed.recipient_user_id
         ORDER BY id DESC LIMIT 1
      ) = 'granted' THEN
        INSERT INTO gift_address_draft_consent_events
          (order_id, recipient_user_id, consent_version, action, actor_user_id)
        SELECT removed.order_id, removed.recipient_user_id, consent_version, 'withdrawn', NULL
          FROM gift_address_draft_consent_events
         WHERE order_id = removed.order_id
           AND recipient_user_id = removed.recipient_user_id
         ORDER BY id DESC LIMIT 1;
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$draft_account_cleanup$;

DROP TRIGGER IF EXISTS users_purge_inactive_gift_address_drafts ON users;
CREATE TRIGGER users_purge_inactive_gift_address_drafts
  AFTER UPDATE OF status ON users
  FOR EACH ROW
  WHEN (NEW.status <> 'active' AND OLD.status = 'active')
  EXECUTE FUNCTION purge_inactive_account_gift_address_drafts();

-- A match becoming inactive also ends the temporary address-processing purpose,
-- even if a separate order-state writer has not yet run.
CREATE OR REPLACE FUNCTION purge_gift_address_drafts_on_match_safety_transition()
RETURNS trigger LANGUAGE plpgsql AS $draft_match_cleanup$
DECLARE
  removed RECORD;
BEGIN
  IF NEW.status <> 'active' AND OLD.status = 'active' THEN
    FOR removed IN
      DELETE FROM gift_address_drafts d
       USING gift_delivery_orders o
       WHERE d.order_id = o.id AND o.match_id = NEW.id
       RETURNING d.order_id, d.recipient_user_id
    LOOP
      IF (
        SELECT action FROM gift_address_draft_consent_events
         WHERE order_id = removed.order_id
           AND recipient_user_id = removed.recipient_user_id
         ORDER BY id DESC LIMIT 1
      ) = 'granted' THEN
        INSERT INTO gift_address_draft_consent_events
          (order_id, recipient_user_id, consent_version, action, actor_user_id)
        SELECT removed.order_id, removed.recipient_user_id, consent_version, 'withdrawn', NULL
          FROM gift_address_draft_consent_events
         WHERE order_id = removed.order_id
           AND recipient_user_id = removed.recipient_user_id
         ORDER BY id DESC LIMIT 1;
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$draft_match_cleanup$;

DROP TRIGGER IF EXISTS matches_purge_inactive_gift_address_drafts ON matches;
CREATE TRIGGER matches_purge_inactive_gift_address_drafts
  AFTER UPDATE OF status ON matches
  FOR EACH ROW
  WHEN (NEW.status <> 'active' AND OLD.status = 'active')
  EXECUTE FUNCTION purge_gift_address_drafts_on_match_safety_transition();

-- Safety events can be written through more than one application path. Enforce
-- immediate ciphertext deletion at the database boundary as well, including
-- high-risk screening holds that do not necessarily change the match state.
CREATE OR REPLACE FUNCTION purge_gift_address_drafts_for_safety_scope(
  p_user_id UUID,
  p_other_user_id UUID DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql AS $draft_safety_scope$
BEGIN
  WITH removed AS (
    DELETE FROM gift_address_drafts d
     USING gift_delivery_orders o
     WHERE d.order_id = o.id
       AND (
         (p_other_user_id IS NULL AND (o.sender_id = p_user_id OR o.recipient_id = p_user_id))
         OR
         (p_other_user_id IS NOT NULL AND (
           (o.sender_id = p_user_id AND o.recipient_id = p_other_user_id)
           OR (o.sender_id = p_other_user_id AND o.recipient_id = p_user_id)
         ))
       )
     RETURNING d.order_id, d.recipient_user_id
  ), revoked AS (
    SELECT r.order_id, r.recipient_user_id, latest.consent_version
      FROM removed r
      JOIN LATERAL (
        SELECT action, consent_version
          FROM gift_address_draft_consent_events
         WHERE order_id = r.order_id
           AND recipient_user_id = r.recipient_user_id
         ORDER BY id DESC LIMIT 1
      ) latest ON latest.action = 'granted'
  )
  INSERT INTO gift_address_draft_consent_events
    (order_id, recipient_user_id, consent_version, action, actor_user_id)
  SELECT order_id, recipient_user_id, consent_version, 'withdrawn', NULL
    FROM revoked;
END;
$draft_safety_scope$;

CREATE OR REPLACE FUNCTION purge_gift_address_drafts_on_block()
RETURNS trigger LANGUAGE plpgsql AS $draft_block$
BEGIN
  PERFORM purge_gift_address_drafts_for_safety_scope(NEW.blocker_id, NEW.blocked_id);
  RETURN NEW;
END;
$draft_block$;

DROP TRIGGER IF EXISTS user_blocks_purge_gift_address_drafts ON user_blocks;
CREATE TRIGGER user_blocks_purge_gift_address_drafts
  AFTER INSERT ON user_blocks
  FOR EACH ROW EXECUTE FUNCTION purge_gift_address_drafts_on_block();

CREATE OR REPLACE FUNCTION purge_gift_address_drafts_on_report()
RETURNS trigger LANGUAGE plpgsql AS $draft_report$
BEGIN
  IF NEW.status IN ('open', 'reviewing') THEN
    PERFORM purge_gift_address_drafts_for_safety_scope(NEW.reporter_id, NEW.reported_user_id);
  END IF;
  RETURN NEW;
END;
$draft_report$;

DROP TRIGGER IF EXISTS user_reports_purge_gift_address_drafts ON user_reports;
CREATE TRIGGER user_reports_purge_gift_address_drafts
  AFTER INSERT OR UPDATE OF status ON user_reports
  FOR EACH ROW EXECUTE FUNCTION purge_gift_address_drafts_on_report();

CREATE OR REPLACE FUNCTION purge_gift_address_drafts_on_high_risk_screening()
RETURNS trigger LANGUAGE plpgsql AS $draft_screening$
BEGIN
  IF NEW.severity = 'high'
     AND NEW.review_status IN ('pending', 'reviewing', 'actioned') THEN
    PERFORM purge_gift_address_drafts_for_safety_scope(NEW.user_id, NULL);
  END IF;
  RETURN NEW;
END;
$draft_screening$;

DROP TRIGGER IF EXISTS user_safety_screenings_purge_gift_address_drafts ON user_safety_screenings;
CREATE TRIGGER user_safety_screenings_purge_gift_address_drafts
  AFTER INSERT OR UPDATE OF severity, review_status ON user_safety_screenings
  FOR EACH ROW EXECUTE FUNCTION purge_gift_address_drafts_on_high_risk_screening();

COMMENT ON FUNCTION purge_gift_address_drafts_for_safety_scope(UUID, UUID) IS
  'Physically deletes live temporary address ciphertext for a blocked/reported pair or high-risk account and appends a non-PII withdrawal event.';
