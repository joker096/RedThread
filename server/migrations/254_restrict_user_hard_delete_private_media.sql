-- A physical users DELETE must not cascade away private-media metadata before
-- the durable object-storage purge queues have recorded the files. Normal account
-- erasure tombstones the user; migrations 134 and 231 queue the paths and remove
-- these metadata rows before any later physical cleanup of the tombstone.
ALTER TABLE photo_assets
  DROP CONSTRAINT IF EXISTS photo_assets_user_id_fkey;
ALTER TABLE photo_assets
  ADD CONSTRAINT photo_assets_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE profile_voice_intros
  DROP CONSTRAINT IF EXISTS profile_voice_intros_user_id_fkey;
ALTER TABLE profile_voice_intros
  ADD CONSTRAINT profile_voice_intros_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;

COMMENT ON CONSTRAINT photo_assets_user_id_fkey ON photo_assets IS
  'Prevent physical account deletion from cascading away private-photo metadata before a durable purge obligation is queued.';
COMMENT ON CONSTRAINT profile_voice_intros_user_id_fkey ON profile_voice_intros IS
  'Prevent physical account deletion from cascading away private voice-intro metadata before a durable purge obligation is queued.';

-- Provider verification documents also reference private external objects.
-- Keep both ownership edges restrictive until a dedicated document-purge
-- workflow has queued and verified deletion of those objects.
ALTER TABLE partner_providers
  DROP CONSTRAINT IF EXISTS partner_providers_user_id_fkey;
ALTER TABLE partner_providers
  ADD CONSTRAINT partner_providers_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE provider_verification_documents
  DROP CONSTRAINT IF EXISTS provider_verification_documents_provider_id_fkey;
ALTER TABLE provider_verification_documents
  ADD CONSTRAINT provider_verification_documents_provider_id_fkey
  FOREIGN KEY (provider_id) REFERENCES partner_providers(id) ON DELETE RESTRICT;

COMMENT ON CONSTRAINT partner_providers_user_id_fkey ON partner_providers IS
  'Prevent physical user deletion from cascading through provider accounts while private verification documents may still exist.';
COMMENT ON CONSTRAINT provider_verification_documents_provider_id_fkey ON provider_verification_documents IS
  'Prevent provider deletion from cascading away private verification document metadata before external objects are safely purged.';
