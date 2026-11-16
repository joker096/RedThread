-- Direct database account tombstoning must purge voice-intro bytes just like
-- the HTTP deletion route. Queue paths before removing metadata so the worker
-- can unlink encrypted files after the transaction commits.
CREATE OR REPLACE FUNCTION queue_deleted_profile_voice_intro_purge()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'deleted' AND OLD.status IS DISTINCT FROM 'deleted' THEN
    INSERT INTO private_voice_intro_purge_queue (storage_path)
    SELECT storage_path
    FROM profile_voice_intros
    WHERE user_id = NEW.id
    ON CONFLICT (storage_path) DO NOTHING;

    DELETE FROM profile_voice_intros
    WHERE user_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_queue_deleted_profile_voice_intro_purge ON users;
CREATE TRIGGER users_queue_deleted_profile_voice_intro_purge
  AFTER UPDATE OF status ON users
  FOR EACH ROW
  WHEN (NEW.status = 'deleted' AND OLD.status IS DISTINCT FROM 'deleted')
  EXECUTE FUNCTION queue_deleted_profile_voice_intro_purge();

COMMENT ON FUNCTION queue_deleted_profile_voice_intro_purge() IS
  'Queues encrypted voice-introduction files for durable physical deletion and removes voice metadata on every account tombstone transition, including direct database/admin updates.';
