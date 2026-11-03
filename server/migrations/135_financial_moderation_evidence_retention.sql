-- Preserve financial and moderation evidence while enforcing the API's report taxonomy.
-- Retention windows are intentionally not guessed here: legal periods vary by jurisdiction.
-- These records are minimal evidence/deduplication data, not full Paddle payload archives.

ALTER TABLE user_reports
  DROP CONSTRAINT IF EXISTS user_reports_category_check;
ALTER TABLE user_reports
  ADD CONSTRAINT user_reports_category_check
  CHECK (category IN (
    'spam', 'fake_profile', 'harassment', 'safety',
    'children_misrepresentation', 'duplicate_profile', 'other'
  ));

CREATE OR REPLACE FUNCTION guard_user_report_evidence()
RETURNS trigger LANGUAGE plpgsql AS $report_evidence$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'user report evidence cannot be deleted directly' USING ERRCODE = '55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.reporter_id IS DISTINCT FROM OLD.reporter_id
     OR NEW.reported_user_id IS DISTINCT FROM OLD.reported_user_id
     OR NEW.category IS DISTINCT FROM OLD.category
     OR NEW.details IS DISTINCT FROM OLD.details
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'user report evidence fields are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'open' AND NEW.status IN ('reviewing', 'resolved', 'dismissed'))
    OR (OLD.status = 'reviewing' AND NEW.status IN ('resolved', 'dismissed'))
  ) THEN
    RAISE EXCEPTION 'invalid user report status transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$report_evidence$;

DROP TRIGGER IF EXISTS user_reports_evidence_immutable ON user_reports;
CREATE TRIGGER user_reports_evidence_immutable
  BEFORE UPDATE OR DELETE ON user_reports
  FOR EACH ROW EXECUTE FUNCTION guard_user_report_evidence();

-- Hard deletion must not cascade-delete report evidence. Normal account deletion
-- is a tombstone transition and remains supported.
ALTER TABLE user_reports
  DROP CONSTRAINT IF EXISTS user_reports_reporter_id_fkey;
ALTER TABLE user_reports
  ADD CONSTRAINT user_reports_reporter_id_fkey
  FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE user_reports
  DROP CONSTRAINT IF EXISTS user_reports_reported_user_id_fkey;
ALTER TABLE user_reports
  ADD CONSTRAINT user_reports_reported_user_id_fkey
  FOREIGN KEY (reported_user_id) REFERENCES users(id) ON DELETE RESTRICT;

-- The audit table's comment promises append-only behavior; enforce it.
-- Permit only the nested FK ON DELETE SET NULL for moderator_id.
CREATE OR REPLACE FUNCTION prevent_moderation_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $moderation_audit$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'moderation audit evidence is append-only' USING ERRCODE = '55000';
  END IF;
  IF pg_trigger_depth() > 1
     AND OLD.moderator_id IS NOT NULL
     AND NEW.moderator_id IS NULL
     AND (to_jsonb(NEW) - 'moderator_id') = (to_jsonb(OLD) - 'moderator_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'moderation audit evidence is append-only' USING ERRCODE = '55000';
END;
$moderation_audit$;

DROP TRIGGER IF EXISTS moderation_audit_log_append_only ON moderation_audit_log;
CREATE TRIGGER moderation_audit_log_append_only
  BEFORE UPDATE OR DELETE ON moderation_audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_moderation_audit_mutation();

-- Event IDs are the durable idempotency barrier. Do not expire them on an
-- arbitrary TTL that could permit a delayed/replayed provider event to apply twice.
CREATE OR REPLACE FUNCTION prevent_paddle_webhook_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $paddle_event$
BEGIN
  RAISE EXCEPTION 'Paddle webhook deduplication evidence is immutable' USING ERRCODE = '55000';
END;
$paddle_event$;

DROP TRIGGER IF EXISTS paddle_webhook_events_immutable ON paddle_webhook_events;
CREATE TRIGGER paddle_webhook_events_immutable
  BEFORE UPDATE OR DELETE ON paddle_webhook_events
  FOR EACH ROW EXECUTE FUNCTION prevent_paddle_webhook_event_mutation();

-- The per-user current-attempt row is reused for the next checkout. Archive the
-- previous terminal attempt before the row is overwritten.
CREATE TABLE IF NOT EXISTS paddle_checkout_attempt_history (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  attempt_id UUID,
  transaction_id TEXT,
  plan TEXT NOT NULL CHECK (plan IN ('1month', '3months', 'lifetime')),
  status TEXT NOT NULL CHECK (status IN ('canceled', 'linked')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS paddle_checkout_attempt_history_attempt_unique
  ON paddle_checkout_attempt_history (attempt_id) WHERE attempt_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS paddle_checkout_attempt_history_transaction_unique
  ON paddle_checkout_attempt_history (transaction_id) WHERE transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS paddle_checkout_attempt_history_user_time_idx
  ON paddle_checkout_attempt_history (user_id, archived_at DESC);

CREATE OR REPLACE FUNCTION archive_paddle_checkout_attempt_before_rollover()
RETURNS trigger LANGUAGE plpgsql AS $checkout_history$
BEGIN
  IF OLD.status IN ('canceled', 'linked')
     AND NEW.status = 'creating'
     AND NEW.attempt_id IS NOT NULL
     AND NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
     AND NEW.transaction_id IS NULL THEN
    INSERT INTO paddle_checkout_attempt_history
      (user_id, attempt_id, transaction_id, plan, status, created_at, updated_at)
    VALUES
      (OLD.user_id, OLD.attempt_id, OLD.transaction_id, OLD.plan, OLD.status, OLD.created_at, OLD.updated_at);
  END IF;
  RETURN NEW;
END;
$checkout_history$;

DROP TRIGGER IF EXISTS paddle_checkout_attempts_archive_before_rollover ON paddle_checkout_attempts;
CREATE TRIGGER paddle_checkout_attempts_archive_before_rollover
  BEFORE UPDATE OF attempt_id, transaction_id, plan, status ON paddle_checkout_attempts
  FOR EACH ROW EXECUTE FUNCTION archive_paddle_checkout_attempt_before_rollover();

CREATE OR REPLACE FUNCTION prevent_paddle_checkout_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $checkout_history_guard$
BEGIN
  RAISE EXCEPTION 'Paddle checkout history is append-only' USING ERRCODE = '55000';
END;
$checkout_history_guard$;

DROP TRIGGER IF EXISTS paddle_checkout_attempt_history_append_only ON paddle_checkout_attempt_history;
CREATE TRIGGER paddle_checkout_attempt_history_append_only
  BEFORE UPDATE OR DELETE ON paddle_checkout_attempt_history
  FOR EACH ROW EXECUTE FUNCTION prevent_paddle_checkout_history_mutation();

-- Preserve active and archived financial attempt evidence if a user row is
-- hard-deleted. The normal account deletion workflow uses a soft tombstone.
ALTER TABLE paddle_checkout_attempts
  DROP CONSTRAINT IF EXISTS paddle_checkout_attempts_user_id_fkey;
ALTER TABLE paddle_checkout_attempts
  ADD CONSTRAINT paddle_checkout_attempts_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;

COMMENT ON TABLE paddle_checkout_attempt_history IS
  'Append-only minimal history of terminal Paddle checkout attempts archived before the per-user current-attempt row is reused. Contains provider transaction IDs, not payment credentials or full provider payloads.';
COMMENT ON TABLE paddle_webhook_events IS
  'Append-only Paddle event-ID deduplication ledger. Stores event ID/type and processing timestamp only; no full webhook payload or customer personal data.';
COMMENT ON TABLE user_reports IS
  'User-submitted moderation evidence. Evidence fields are immutable; status may move open -> reviewing -> resolved/dismissed. Retention must follow an approved jurisdiction-specific schedule.';
