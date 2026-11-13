-- Worker leases prevent concurrent migration and fence stale workers.
-- This migration adds coordination metadata only; it does not process audio or change profile references.
ALTER TABLE voice_intro_migration_journal
  ADD COLUMN IF NOT EXISTS lease_token UUID,
  ADD COLUMN IF NOT EXISTS lease_owner VARCHAR(128),
  ADD COLUMN IF NOT EXISTS lease_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lease_generation BIGINT NOT NULL DEFAULT 0;

DO $lease_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'voice_intro_migration_lease_pair_check'
      AND conrelid = 'voice_intro_migration_journal'::regclass
  ) THEN
    ALTER TABLE voice_intro_migration_journal
      ADD CONSTRAINT voice_intro_migration_lease_pair_check CHECK (
        (lease_token IS NULL AND lease_owner IS NULL AND lease_claimed_at IS NULL AND lease_expires_at IS NULL)
        OR
        (lease_token IS NOT NULL AND lease_owner IS NOT NULL
          AND length(lease_owner) BETWEEN 1 AND 128
          AND lease_claimed_at IS NOT NULL AND lease_expires_at > lease_claimed_at)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'voice_intro_migration_lease_generation_check'
      AND conrelid = 'voice_intro_migration_journal'::regclass
  ) THEN
    ALTER TABLE voice_intro_migration_journal
      ADD CONSTRAINT voice_intro_migration_lease_generation_check CHECK (lease_generation >= 0);
  END IF;
END;
$lease_constraints$;

CREATE INDEX IF NOT EXISTS voice_intro_migration_lease_recovery_idx
  ON voice_intro_migration_journal (lease_expires_at, created_at, id)
  WHERE state NOT IN ('completed', 'rolled_back');

CREATE OR REPLACE FUNCTION guard_voice_intro_migration_journal_lease()
RETURNS trigger
LANGUAGE plpgsql
AS $lease_guard$
BEGIN
  IF NEW.lease_generation < OLD.lease_generation THEN
    RAISE EXCEPTION 'voice intro migration lease generation cannot decrease'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.lease_token IS DISTINCT FROM OLD.lease_token THEN
    IF NEW.lease_token IS NULL THEN
      IF OLD.lease_token IS NULL OR NEW.lease_generation <> OLD.lease_generation
         OR NEW.lease_owner IS NOT NULL OR NEW.lease_claimed_at IS NOT NULL
         OR NEW.lease_expires_at IS NOT NULL THEN
        RAISE EXCEPTION 'voice intro migration lease release is invalid'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      IF (OLD.lease_token IS NOT NULL AND OLD.lease_expires_at > statement_timestamp())
         OR NEW.lease_generation <> OLD.lease_generation + 1
         OR NEW.lease_owner IS NULL OR NEW.lease_claimed_at IS NULL
         OR NEW.lease_expires_at <= statement_timestamp() THEN
        RAISE EXCEPTION 'voice intro migration lease acquisition is invalid'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF NEW.lease_token IS NOT NULL THEN
    IF NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
       OR NEW.lease_claimed_at IS DISTINCT FROM OLD.lease_claimed_at
       OR NEW.lease_generation <> OLD.lease_generation
       OR NEW.lease_expires_at <= OLD.lease_expires_at THEN
      RAISE EXCEPTION 'voice intro migration lease renewal is invalid'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.lease_owner IS NOT NULL OR NEW.lease_claimed_at IS NOT NULL
       OR NEW.lease_expires_at IS NOT NULL THEN
    RAISE EXCEPTION 'unowned voice intro migration lease metadata is invalid'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$lease_guard$;

DROP TRIGGER IF EXISTS voice_intro_migration_journal_lease_guard
  ON voice_intro_migration_journal;
CREATE TRIGGER voice_intro_migration_journal_lease_guard
  BEFORE UPDATE ON voice_intro_migration_journal
  FOR EACH ROW EXECUTE FUNCTION guard_voice_intro_migration_journal_lease();

COMMENT ON COLUMN voice_intro_migration_journal.lease_token IS
  'Random fencing token held by the current migration worker; null when unleased.';
COMMENT ON COLUMN voice_intro_migration_journal.lease_generation IS
  'Monotonic fencing generation incremented on every lease acquisition.';
