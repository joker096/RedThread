-- Durable, PII-free state for the future voice-introduction re-encryption runner.
-- This migration creates storage only; it does not inspect or modify audio files.
CREATE TABLE IF NOT EXISTS voice_intro_migration_journal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(idempotency_key) BETWEEN 1 AND 160),
  voice_intro_id UUID NOT NULL,
  source_path TEXT NOT NULL CHECK (length(source_path) BETWEEN 1 AND 2048),
  source_sha256 CHAR(64) NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_format TEXT NOT NULL CHECK (source_format IN ('VOWVOICE1', 'VOWVOICE2')),
  target_key_id VARCHAR(64) NOT NULL CHECK (target_key_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  state TEXT NOT NULL DEFAULT 'planned'
    CHECK (state IN (
      'planned', 'source_authenticated', 'staged_authenticated',
      'reference_switched', 'rollback_window', 'completed', 'rolled_back'
    )),
  staged_path TEXT,
  staged_sha256 CHAR(64),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  source_authenticated_at TIMESTAMPTZ,
  staged_authenticated_at TIMESTAMPTZ,
  reference_switched_at TIMESTAMPTZ,
  rollback_deadline TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error_code VARCHAR(64)
    CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{1,64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT voice_intro_migration_staged_pair_check CHECK (
    (staged_path IS NULL AND staged_sha256 IS NULL AND staged_authenticated_at IS NULL)
    OR
    (staged_path IS NOT NULL AND staged_sha256 ~ '^[a-f0-9]{64}$' AND staged_authenticated_at IS NOT NULL)
  ),
  CONSTRAINT voice_intro_migration_switch_requires_stage_check CHECK (
    state NOT IN ('reference_switched', 'rollback_window', 'completed', 'rolled_back')
    OR (staged_path IS NOT NULL AND staged_sha256 IS NOT NULL AND reference_switched_at IS NOT NULL)
  ),
  CONSTRAINT voice_intro_migration_terminal_timestamp_check CHECK (
    (state IN ('completed', 'rolled_back')) = (completed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS voice_intro_migration_one_active_per_intro_idx
  ON voice_intro_migration_journal (voice_intro_id)
  WHERE state NOT IN ('completed', 'rolled_back');

CREATE INDEX IF NOT EXISTS voice_intro_migration_recovery_idx
  ON voice_intro_migration_journal (state, updated_at, id)
  WHERE state NOT IN ('completed', 'rolled_back');

CREATE TABLE IF NOT EXISTS voice_intro_migration_journal_events (
  id BIGSERIAL PRIMARY KEY,
  journal_id UUID NOT NULL REFERENCES voice_intro_migration_journal(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  from_state TEXT,
  to_state TEXT NOT NULL CHECK (to_state IN (
    'planned', 'source_authenticated', 'staged_authenticated',
    'reference_switched', 'rollback_window', 'completed', 'rolled_back'
  )),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  error_code VARCHAR(64)
    CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,64}$'),
  UNIQUE (journal_id, version),
  CHECK (
    (version = 1 AND from_state IS NULL AND to_state = 'planned')
    OR (version > 1 AND from_state IS NOT NULL)
  )
);

CREATE OR REPLACE FUNCTION enforce_voice_intro_migration_journal_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $migration_journal$
DECLARE
  allowed BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'planned' OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'voice intro migration journal must start planned at version 1'
        USING ERRCODE = '23514';
    END IF;
    INSERT INTO voice_intro_migration_journal_events
      (journal_id, version, from_state, to_state, occurred_at)
    VALUES (NEW.id, 1, NULL, 'planned', NEW.created_at);
    RETURN NEW;
  END IF;

  IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.voice_intro_id IS DISTINCT FROM OLD.voice_intro_id
     OR NEW.source_path IS DISTINCT FROM OLD.source_path
     OR NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256
     OR NEW.source_format IS DISTINCT FROM OLD.source_format
     OR NEW.target_key_id IS DISTINCT FROM OLD.target_key_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'voice intro migration source identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    allowed := CASE OLD.state
      WHEN 'planned' THEN NEW.state = 'source_authenticated'
      WHEN 'source_authenticated' THEN NEW.state = 'staged_authenticated'
      WHEN 'staged_authenticated' THEN NEW.state = 'reference_switched'
      WHEN 'reference_switched' THEN NEW.state IN ('rollback_window', 'rolled_back')
      WHEN 'rollback_window' THEN NEW.state IN ('completed', 'rolled_back')
      ELSE FALSE
    END;
    IF NOT allowed THEN
      RAISE EXCEPTION 'voice intro migration journal transition is not allowed'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION 'voice intro migration journal version or timestamp is invalid'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.state = 'source_authenticated' THEN
      NEW.source_authenticated_at := COALESCE(NEW.source_authenticated_at, NEW.updated_at);
    ELSIF NEW.state = 'staged_authenticated' THEN
      IF NEW.staged_path IS NULL OR NEW.staged_path = OLD.source_path
         OR NEW.staged_sha256 IS NULL OR NEW.staged_authenticated_at IS NULL THEN
        RAISE EXCEPTION 'authenticated staged artifact is required'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.state = 'reference_switched' THEN
      NEW.reference_switched_at := COALESCE(NEW.reference_switched_at, NEW.updated_at);
    ELSIF NEW.state IN ('completed', 'rolled_back') THEN
      NEW.completed_at := COALESCE(NEW.completed_at, NEW.updated_at);
    END IF;
    INSERT INTO voice_intro_migration_journal_events
      (journal_id, version, from_state, to_state, occurred_at, error_code)
    VALUES (NEW.id, NEW.version, OLD.state, NEW.state, NEW.updated_at, NEW.last_error_code);
  ELSIF NEW.version IS DISTINCT FROM OLD.version THEN
    RAISE EXCEPTION 'journal version can change only with a state transition'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$migration_journal$;

DROP TRIGGER IF EXISTS voice_intro_migration_journal_transition_guard
  ON voice_intro_migration_journal;
CREATE TRIGGER voice_intro_migration_journal_transition_guard
  BEFORE INSERT OR UPDATE ON voice_intro_migration_journal
  FOR EACH ROW EXECUTE FUNCTION enforce_voice_intro_migration_journal_transition();

CREATE OR REPLACE FUNCTION protect_voice_intro_migration_journal_events()
RETURNS trigger
LANGUAGE plpgsql
AS $migration_events$
BEGIN
  RAISE EXCEPTION 'voice intro migration journal events are append-only'
    USING ERRCODE = '55000';
END;
$migration_events$;

DROP TRIGGER IF EXISTS voice_intro_migration_journal_events_immutable
  ON voice_intro_migration_journal_events;
CREATE TRIGGER voice_intro_migration_journal_events_immutable
  BEFORE UPDATE OR DELETE ON voice_intro_migration_journal_events
  FOR EACH ROW EXECUTE FUNCTION protect_voice_intro_migration_journal_events();

COMMENT ON TABLE voice_intro_migration_journal IS
  'Durable, non-secret state for controlled voice-introduction ciphertext re-encryption. No audio bytes or key material are stored.';
COMMENT ON TABLE voice_intro_migration_journal_events IS
  'Append-only transition history for the voice-introduction migration journal.';
