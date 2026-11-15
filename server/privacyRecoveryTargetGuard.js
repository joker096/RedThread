const DATABASE_NAME = /^vow_restore_[a-z0-9_]{1,48}$/;
const DATABASE_ROLE = /^vow_restore_[a-z0-9_]{1,48}$/;
const CONFIRMATION = 'ISOLATED_RESTORE_ONLY';

export function assertPrivacyRecoveryRestoreTargetConfig(env = process.env) {
  if (env.PRIVACY_RECOVERY_RESTORE_ISOLATED !== 'true' ||
      typeof env.PRIVACY_RECOVERY_RESTORE_DATABASE_NAME !== 'string' ||
      !DATABASE_NAME.test(env.PRIVACY_RECOVERY_RESTORE_DATABASE_NAME) ||
      typeof env.PRIVACY_RECOVERY_RESTORE_DATABASE_ROLE !== 'string' ||
      !DATABASE_ROLE.test(env.PRIVACY_RECOVERY_RESTORE_DATABASE_ROLE) ||
      env.PRIVACY_RECOVERY_RESTORE_CONFIRMATION !== CONFIRMATION) {
    throw new Error('privacy_recovery_restore_target_not_explicitly_configured');
  }
}

export async function assertPrivacyRecoveryRestoreTarget(client, env = process.env) {
  assertPrivacyRecoveryRestoreTargetConfig(env);
  const result = await client.query(
    'SELECT current_database() AS database_name, current_user AS database_role'
  );
  const row = result.rows?.[0];
  if (!row ||
      row.database_name !== env.PRIVACY_RECOVERY_RESTORE_DATABASE_NAME ||
      row.database_role !== env.PRIVACY_RECOVERY_RESTORE_DATABASE_ROLE) {
    throw new Error('privacy_recovery_restore_database_identity_mismatch');
  }
  return { databaseName: row.database_name, databaseRole: row.database_role };
}
