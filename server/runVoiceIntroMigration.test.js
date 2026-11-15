import test from 'node:test';
import assert from 'node:assert/strict';
import { runVoiceIntroMigrationOnce } from './runVoiceIntroMigration.js';

test('voice migration runner is disabled unless explicitly enabled', async () => {
  await assert.rejects(
    runVoiceIntroMigrationOnce({ VOICE_INTRO_MIGRATION_ENABLED: 'false' }),
    /voice_intro_migration_not_enabled/
  );
});

test('voice migration runner requires a versioned keyring and retained legacy key', async () => {
  await assert.rejects(
    runVoiceIntroMigrationOnce({
      VOICE_INTRO_MIGRATION_ENABLED: 'true',
      DATABASE_URL: 'postgres://unused.invalid/db',
      VOICE_INTRO_STORAGE_DIR: '/private/voice',
      VOICE_INTRO_ENCRYPTION_KEY: '11'.repeat(32)
    }),
    /versioned_voice_keyring_with_legacy_key_required/
  );
});

test('voice migration runner rejects missing database and storage configuration', async () => {
  await assert.rejects(
    runVoiceIntroMigrationOnce({ VOICE_INTRO_MIGRATION_ENABLED: 'true' }),
    /DATABASE_URL_required/
  );
});
