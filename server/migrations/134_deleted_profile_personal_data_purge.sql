-- Remove profile-derived personal data whenever an account becomes a tombstone.
ALTER TABLE profiles ALTER COLUMN gender DROP NOT NULL;

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

CREATE OR REPLACE FUNCTION scrub_deleted_account_profile()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'deleted' AND OLD.status IS DISTINCT FROM 'deleted' THEN
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
$$;

DROP TRIGGER IF EXISTS users_scrub_deleted_account_profile ON users;
CREATE TRIGGER users_scrub_deleted_account_profile
  AFTER UPDATE OF status ON users
  FOR EACH ROW
  WHEN (NEW.status = 'deleted' AND OLD.status IS DISTINCT FROM 'deleted')
  EXECUTE FUNCTION scrub_deleted_account_profile();

COMMENT ON FUNCTION scrub_deleted_account_profile() IS
  'Erases profile-derived personal data on account deletion while retaining a non-discoverable relational tombstone.';
