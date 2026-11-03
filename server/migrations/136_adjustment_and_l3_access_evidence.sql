-- Preserve L3 media-view audit records after the encrypted video and its
-- workflow submission are physically purged. Keep opaque UUID references only.
ALTER TABLE identity_l3_media_access_events
  ADD COLUMN submission_ref UUID,
  ADD COLUMN moderator_ref UUID;

UPDATE identity_l3_media_access_events
SET submission_ref = submission_id,
    moderator_ref = moderator_user_id;

ALTER TABLE identity_l3_media_access_events
  ALTER COLUMN submission_ref SET NOT NULL,
  ALTER COLUMN moderator_ref SET NOT NULL,
  ALTER COLUMN submission_id DROP NOT NULL,
  ALTER COLUMN moderator_user_id DROP NOT NULL;

ALTER TABLE identity_l3_media_access_events
  DROP CONSTRAINT identity_l3_media_access_events_submission_id_fkey,
  DROP CONSTRAINT identity_l3_media_access_events_moderator_user_id_fkey;

ALTER TABLE identity_l3_media_access_events
  ADD CONSTRAINT identity_l3_media_access_events_submission_id_fkey
    FOREIGN KEY (submission_id) REFERENCES identity_l3_submissions(id) ON DELETE SET NULL,
  ADD CONSTRAINT identity_l3_media_access_events_moderator_user_id_fkey
    FOREIGN KEY (moderator_user_id) REFERENCES users(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION snapshot_identity_l3_media_access_event_refs()
RETURNS trigger LANGUAGE plpgsql AS $l3_media_access_snapshot$
BEGIN
  IF NEW.submission_id IS NOT NULL
     AND NEW.submission_ref IS NOT NULL
     AND NEW.submission_ref IS DISTINCT FROM NEW.submission_id THEN
    RAISE EXCEPTION 'L3 media access submission snapshot must match its live reference'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.moderator_user_id IS NOT NULL
     AND NEW.moderator_ref IS NOT NULL
     AND NEW.moderator_ref IS DISTINCT FROM NEW.moderator_user_id THEN
    RAISE EXCEPTION 'L3 media access moderator snapshot must match its live reference'
      USING ERRCODE = '23514';
  END IF;
  NEW.submission_ref := COALESCE(NEW.submission_ref, NEW.submission_id);
  NEW.moderator_ref := COALESCE(NEW.moderator_ref, NEW.moderator_user_id);
  RETURN NEW;
END;
$l3_media_access_snapshot$;

CREATE TRIGGER identity_l3_media_access_events_snapshot_refs
  BEFORE INSERT ON identity_l3_media_access_events
  FOR EACH ROW EXECUTE FUNCTION snapshot_identity_l3_media_access_event_refs();

CREATE INDEX identity_l3_media_access_submission_ref_idx
  ON identity_l3_media_access_events(submission_ref, accessed_at DESC, id);
CREATE INDEX identity_l3_media_access_moderator_ref_idx
  ON identity_l3_media_access_events(moderator_ref, accessed_at DESC, id);

-- Populate immutable identity snapshots for all existing and future access
-- events. Application inserts may continue to provide only the live FK columns.
CREATE OR REPLACE FUNCTION populate_identity_l3_media_access_event_refs()
RETURNS trigger LANGUAGE plpgsql AS $l3_media_access_refs$
BEGIN
  NEW.submission_ref := NEW.submission_id;
  NEW.moderator_ref := NEW.moderator_user_id;
  IF NEW.submission_ref IS NULL OR NEW.moderator_ref IS NULL THEN
    RAISE EXCEPTION 'L3 media access events require submission and moderator provenance'
      USING ERRCODE = '23502';
  END IF;
  RETURN NEW;
END;
$l3_media_access_refs$;

CREATE TRIGGER identity_l3_media_access_events_snapshot_refs
  BEFORE INSERT ON identity_l3_media_access_events
  FOR EACH ROW EXECUTE FUNCTION populate_identity_l3_media_access_event_refs();

-- Direct UPDATE/DELETE remains forbidden. Only nested FK SET NULL actions may
-- clear the live FK columns; immutable UUID snapshots retain the audit linkage.
CREATE OR REPLACE FUNCTION prevent_identity_l3_media_access_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $l3_media_access_audit$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.submission_id IS NULL OR NEW.submission_id IS NOT DISTINCT FROM OLD.submission_id)
     AND (NEW.moderator_user_id IS NULL OR NEW.moderator_user_id IS NOT DISTINCT FROM OLD.moderator_user_id)
     AND (
       NEW.submission_id IS DISTINCT FROM OLD.submission_id
       OR NEW.moderator_user_id IS DISTINCT FROM OLD.moderator_user_id
     )
     AND (to_jsonb(NEW) - 'submission_id' - 'moderator_user_id')
         = (to_jsonb(OLD) - 'submission_id' - 'moderator_user_id') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'identity L3 media access events are append-only'
    USING ERRCODE = '55000';
END;
$l3_media_access_audit$;

DROP TRIGGER IF EXISTS identity_l3_media_access_events_append_only
  ON identity_l3_media_access_events;
CREATE TRIGGER identity_l3_media_access_events_append_only
  BEFORE UPDATE OR DELETE ON identity_l3_media_access_events
  FOR EACH ROW EXECUTE FUNCTION prevent_identity_l3_media_access_event_mutation();

-- Preserve the provenance of existing lifetime entitlements before new
-- adjustment events can revoke or reinstate them.
CREATE TABLE paddle_lifetime_entitlements (
  transaction_id TEXT PRIMARY KEY CHECK (transaction_id ~ '^txn_[A-Za-z0-9]+$'),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  revoke_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CHECK ((status = 'active' AND revoke_reason IS NULL) OR status = 'revoked')
);

CREATE INDEX paddle_lifetime_entitlements_user_status_idx
  ON paddle_lifetime_entitlements(user_id, status);

INSERT INTO paddle_lifetime_entitlements (transaction_id, user_id, status)
SELECT transaction_id, user_id, 'active'
FROM (
  SELECT a.transaction_id, a.user_id
  FROM paddle_checkout_attempts a
  JOIN users u ON u.id = a.user_id
  WHERE a.plan = 'lifetime' AND a.status = 'linked'
    AND a.transaction_id IS NOT NULL AND u.premium_lifetime IS TRUE
  UNION
  SELECT h.transaction_id, h.user_id
  FROM paddle_checkout_attempt_history h
  JOIN users u ON u.id = h.user_id
  WHERE h.plan = 'lifetime' AND h.status = 'linked'
    AND h.transaction_id IS NOT NULL AND u.premium_lifetime IS TRUE
) linked_lifetime_transactions
ON CONFLICT (transaction_id) DO NOTHING;

-- Keep every adjustment event, not only the latest state. This is necessary
-- to distinguish pending refunds, approved refunds and later chargeback reversals.
CREATE TABLE paddle_adjustment_events (
  event_id TEXT PRIMARY KEY REFERENCES paddle_webhook_events(event_id) ON DELETE RESTRICT,
  adjustment_id TEXT NOT NULL CHECK (adjustment_id ~ '^adj_[A-Za-z0-9]+$'),
  transaction_id TEXT NOT NULL CHECK (transaction_id ~ '^txn_[A-Za-z0-9]+$'),
  action TEXT NOT NULL CHECK (action IN (
    'credit', 'refund', 'chargeback', 'chargeback_reverse',
    'chargeback_warning', 'chargeback_warning_reverse', 'credit_reverse'
  )),
  adjustment_type TEXT CHECK (adjustment_type IS NULL OR adjustment_type IN ('full', 'partial')),
  status TEXT NOT NULL CHECK (status IN ('pending_approval', 'approved', 'rejected', 'reversed')),
  amount_minor_units BIGINT CHECK (amount_minor_units IS NULL OR amount_minor_units >= 0),
  currency_code CHAR(3) CHECK (currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'),
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);

CREATE INDEX paddle_adjustment_events_transaction_time_idx
  ON paddle_adjustment_events(transaction_id, occurred_at DESC, received_at DESC);
CREATE INDEX paddle_adjustment_events_transaction_adjustment_time_idx
  ON paddle_adjustment_events(transaction_id, adjustment_id, occurred_at DESC, received_at DESC, event_id DESC);

CREATE OR REPLACE FUNCTION prevent_paddle_adjustment_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $paddle_adjustment_event$
BEGIN
  RAISE EXCEPTION 'Paddle adjustment evidence is append-only'
    USING ERRCODE = '55000';
END;
$paddle_adjustment_event$;

CREATE TRIGGER paddle_adjustment_events_append_only
  BEFORE UPDATE OR DELETE ON paddle_adjustment_events
  FOR EACH ROW EXECUTE FUNCTION prevent_paddle_adjustment_event_mutation();

COMMENT ON TABLE paddle_lifetime_entitlements IS
  'Current entitlement projection for verified Vow lifetime transactions. Transaction IDs are retained for refund/chargeback reconciliation; no payment credentials or full provider payloads are stored.';
COMMENT ON TABLE paddle_adjustment_events IS
  'Append-only minimal Paddle adjustment event ledger. Retains provider event/adjustment/transaction IDs, action, type, status, amount in minor units, currency and provider event time; never stores full payloads or payment credentials.';
COMMENT ON COLUMN identity_l3_media_access_events.submission_ref IS
  'Immutable opaque UUID snapshot preserving which L3 submission was viewed after its media and workflow row are purged.';
COMMENT ON COLUMN identity_l3_media_access_events.moderator_ref IS
  'Immutable opaque UUID snapshot preserving which moderator viewed L3 media after the moderator account row is removed.';
