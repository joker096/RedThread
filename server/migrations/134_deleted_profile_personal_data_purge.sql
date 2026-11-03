-- Remove profile-derived personal data whenever an account becomes a tombstone.
-- The same durable queue is also created by the private-photo purge PR.
-- Keep account erasure safe even when a future admin/background path marks a user deleted.
CREATE TABLE IF NOT EXISTS private_photo_purge_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_path TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  last_error_code TEXT,
  CHECK (length(storage_path) BETWEEN 1 AND 2048)
);

CREATE INDEX IF NOT EXISTS private_photo_purge_queue_due_idx
  ON private_photo_purge_queue (next_attempt_at, created_at);

ALTER TABLE profiles ALTER COLUMN gender DROP NOT NULL;

CREATE OR REPLACE FUNCTION require_gender_for_non_deleted_profile()
RETURNS trigger LANGUAGE plpgsql AS $gender_guard$
BEGIN
  IF NEW.gender IS NULL AND EXISTS (
    SELECT 1 FROM users WHERE id = NEW.user_id AND status <> 'deleted'
  ) THEN
    RAISE EXCEPTION 'non-deleted profiles require gender' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$gender_guard$;

DROP TRIGGER IF EXISTS profiles_require_gender_unless_deleted ON profiles;
CREATE TRIGGER profiles_require_gender_unless_deleted
  BEFORE INSERT OR UPDATE OF gender, user_id ON profiles
  FOR EACH ROW EXECUTE FUNCTION require_gender_for_non_deleted_profile();

DELETE FROM user_safety_screenings AS s
USING users AS u
WHERE u.id = s.user_id AND u.status = 'deleted';

-- Backfill credentials/contact data for tombstones created before this migration.
UPDATE users
SET email = 'deleted+' || id::text || '@deleted.invalid',
    password_hash = NULL,
    phone_e164 = NULL,
    phone_verified_at = NULL,
    female_trial_ends_at = NULL,
    premium_until = NULL,
    premium_lifetime = FALSE,
    updated_at = statement_timestamp()
WHERE status = 'deleted';

-- Backfill private-photo deletion for previously deleted accounts.
INSERT INTO private_photo_purge_queue (storage_path)
SELECT a.storage_path
FROM photo_assets AS a
JOIN users AS u ON u.id = a.user_id
WHERE u.status = 'deleted'
ON CONFLICT (storage_path) DO NOTHING;
DELETE FROM photo_assets AS a
USING users AS u
WHERE u.id = a.user_id AND u.status = 'deleted';

-- Backfill active L3 submissions belonging to existing tombstones. The L3
-- status trigger creates durable purge jobs without discarding object keys.
SELECT set_config('app.identity_l3_actor_user_id', '', TRUE);
SELECT set_config('app.identity_l3_reason_code', 'account_deleted', TRUE);
UPDATE identity_l3_submissions AS s
SET status = CASE WHEN s.status = 'approved' THEN 'revoked' ELSE 'withdrawn' END,
    revoked_at = CASE WHEN s.status = 'approved' THEN statement_timestamp() ELSE s.revoked_at END,
    processing_lease_token = NULL,
    processing_lease_expires_at = NULL
FROM users AS u
WHERE u.id = s.user_id AND u.status = 'deleted'
  AND s.storage_object_key IS NOT NULL
  AND s.status IN ('draft', 'upload_authorized', 'uploaded', 'processing', 'pending_review', 'approved');

UPDATE profiles AS p
SET display_name = 'Удалённый пользователь',
    birth_date = NULL,
    gender = NULL,
    country = '—',
    city = '—',
    bio = '',
    photo_urls = '{}',
    occupation = '',
    education = '',
    languages = '{}',
    relationship_intent = 'marriage_family',
    family_format = 'open_to_both',
    has_children = NULL,
    children_disclosure_confirmed_at = NULL,
    wants_children = 'discuss',
    children_living_arrangement = 'not_applicable',
    family_values = '{}',
    is_visible = FALSE,
    updated_at = statement_timestamp()
FROM users AS u
WHERE u.id = p.user_id AND u.status = 'deleted';

-- A deleted profile is a tombstone, not an editable hidden profile. The
-- account-erasure trigger is the only nested writer allowed to scrub it.
CREATE OR REPLACE FUNCTION prevent_deleted_profile_repopulation()
RETURNS trigger LANGUAGE plpgsql AS $profile_tombstone$
BEGIN
  IF pg_trigger_depth() = 1 THEN
    IF EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND status = 'deleted') THEN
      RAISE EXCEPTION 'deleted account profile is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND EXISTS (
      SELECT 1 FROM users WHERE id = OLD.user_id AND status = 'deleted'
    ) THEN
      RAISE EXCEPTION 'deleted account profile is immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$profile_tombstone$;

DROP TRIGGER IF EXISTS profiles_deleted_account_immutable ON profiles;
CREATE TRIGGER profiles_deleted_account_immutable
  BEFORE INSERT OR UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION prevent_deleted_profile_repopulation();

-- Do not allow deleted-account contact, credential, entitlement or Paddle
-- reconciliation identities to be repopulated or reassigned after scrubbing.
-- Nested updates from scrub_deleted_account_data() are the trusted erasure path.
CREATE OR REPLACE FUNCTION prevent_deleted_account_identity_mutation()
RETURNS trigger LANGUAGE plpgsql AS $account_tombstone$
BEGIN
  IF OLD.status = 'deleted' AND pg_trigger_depth() = 1 AND (
    NEW.email IS DISTINCT FROM OLD.email
    OR NEW.password_hash IS DISTINCT FROM OLD.password_hash
    OR NEW.phone_e164 IS DISTINCT FROM OLD.phone_e164
    OR NEW.phone_verified_at IS DISTINCT FROM OLD.phone_verified_at
    OR NEW.female_trial_ends_at IS DISTINCT FROM OLD.female_trial_ends_at
    OR NEW.premium_until IS DISTINCT FROM OLD.premium_until
    OR NEW.premium_lifetime IS DISTINCT FROM OLD.premium_lifetime
    OR NEW.paddle_customer_id IS DISTINCT FROM OLD.paddle_customer_id
    OR NEW.paddle_subscription_id IS DISTINCT FROM OLD.paddle_subscription_id
    OR NEW.paddle_subscription_status IS DISTINCT FROM OLD.paddle_subscription_status
    OR NEW.paddle_price_id IS DISTINCT FROM OLD.paddle_price_id
    OR NEW.paddle_subscription_updated_at IS DISTINCT FROM OLD.paddle_subscription_updated_at
  ) THEN
    RAISE EXCEPTION 'deleted account identity and billing tombstone are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$account_tombstone$;

DROP TRIGGER IF EXISTS users_deleted_account_identity_immutable ON users;
CREATE TRIGGER users_deleted_account_identity_immutable
  BEFORE UPDATE OF email, password_hash, phone_e164, phone_verified_at,
    female_trial_ends_at, premium_until, premium_lifetime,
    paddle_customer_id, paddle_subscription_id, paddle_subscription_status,
    paddle_price_id, paddle_subscription_updated_at
  ON users
  FOR EACH ROW EXECUTE FUNCTION prevent_deleted_account_identity_mutation();


CREATE OR REPLACE FUNCTION scrub_deleted_account_data()
RETURNS trigger LANGUAGE plpgsql AS $profile_scrub$
BEGIN
  IF NEW.status = 'deleted' AND OLD.status IS DISTINCT FROM 'deleted' THEN
    DELETE FROM user_safety_screenings WHERE user_id = NEW.id;

    -- A direct status transition must scrub account credentials/contact data
    -- just like the HTTP deletion route. Keep only the non-reversible tombstone
    -- email needed by the users.email NOT NULL/UNIQUE invariant.
    UPDATE users
    SET email = 'deleted+' || NEW.id::text || '@deleted.invalid',
        password_hash = NULL,
        phone_e164 = NULL,
        phone_verified_at = NULL,
        female_trial_ends_at = NULL,
        premium_until = NULL,
        premium_lifetime = FALSE,
        updated_at = statement_timestamp()
    WHERE id = NEW.id;

    -- Queue photo bytes before removing their metadata. Filesystem operations
    -- cannot run inside PostgreSQL, so the durable worker performs the unlink.
    INSERT INTO private_photo_purge_queue (storage_path)
    SELECT storage_path FROM photo_assets WHERE user_id = NEW.id
    ON CONFLICT (storage_path) DO NOTHING;
    DELETE FROM photo_assets WHERE user_id = NEW.id;

    -- Route-level account deletion preflights L3 media, but direct admin or
    -- background status transitions must also retire media and enqueue purge.
    PERFORM set_config('app.identity_l3_actor_user_id', '', TRUE);
    PERFORM set_config('app.identity_l3_reason_code', 'account_deleted', TRUE);
    UPDATE identity_l3_submissions
    SET status = CASE WHEN status = 'approved' THEN 'revoked' ELSE 'withdrawn' END,
        revoked_at = CASE WHEN status = 'approved' THEN statement_timestamp() ELSE revoked_at END,
        processing_lease_token = NULL,
        processing_lease_expires_at = NULL
    WHERE user_id = NEW.id
      AND storage_object_key IS NOT NULL
      AND status IN ('draft', 'upload_authorized', 'uploaded', 'processing', 'pending_review', 'approved');

    UPDATE profiles
    SET display_name = 'Удалённый пользователь',
        birth_date = NULL,
        gender = NULL,
        country = '—',
        city = '—',
        bio = '',
        photo_urls = '{}',
        occupation = '',
        education = '',
        languages = '{}',
        relationship_intent = 'marriage_family',
        family_format = 'open_to_both',
        has_children = NULL,
        children_disclosure_confirmed_at = NULL,
        wants_children = 'discuss',
        children_living_arrangement = 'not_applicable',
        family_values = '{}',
        is_visible = FALSE,
        updated_at = statement_timestamp()
    WHERE user_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$profile_scrub$;

DROP TRIGGER IF EXISTS users_scrub_deleted_account_profile ON users;
DROP TRIGGER IF EXISTS users_scrub_deleted_account_data ON users;
CREATE TRIGGER users_scrub_deleted_account_data
  AFTER UPDATE OF status ON users
  FOR EACH ROW
  WHEN (NEW.status = 'deleted' AND OLD.status IS DISTINCT FROM 'deleted')
  EXECUTE FUNCTION scrub_deleted_account_data();

COMMENT ON FUNCTION scrub_deleted_account_data() IS
  'Scrubs credentials, contact and profile data, removes photo metadata, queues private photo/L3 media purge, and removes transient safety screenings when an account is deleted.';

-- A deleted account is a terminal tombstone. Reactivation would expose an
-- intentionally scrubbed profile whose required identity fields no longer exist.
CREATE OR REPLACE FUNCTION prevent_deleted_account_reactivation()
RETURNS trigger LANGUAGE plpgsql AS $deleted_terminal$
BEGIN
  IF OLD.status = 'deleted' AND NEW.status <> 'deleted' THEN
    RAISE EXCEPTION 'deleted accounts cannot be reactivated'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$deleted_terminal$;

DROP TRIGGER IF EXISTS users_deleted_account_terminal ON users;
CREATE TRIGGER users_deleted_account_terminal
  BEFORE UPDATE OF status ON users
  FOR EACH ROW EXECUTE FUNCTION prevent_deleted_account_reactivation();

COMMENT ON FUNCTION prevent_deleted_account_reactivation() IS
  'Deleted account tombstones are terminal; users must register a new account rather than reactivate a scrubbed identity.';
