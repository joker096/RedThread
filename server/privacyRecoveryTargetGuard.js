const DATABASE_NAME = /^vow_restore_[a-z0-9_]{1,48}$/;
const DATABASE_ROLE = /^vow_restore_[a-z0-9_]{1,48}$/;
const CONFIRMATION = 'ISOLATED_RESTORE_ONLY';

export function assertPrivacyRecoveryRestoreTargetConfig(env = process.env) {
  if (env.NODE_ENV === 'production' || env.PRIVACY_RECOVERY_RESTORE_ISOLATED !== 'true' ||
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
  const identity = await client.query(
    'SELECT current_database() AS database_name, current_user AS database_role'
  );
  const row = identity.rows?.[0];
  if (!row ||
      row.database_name !== env.PRIVACY_RECOVERY_RESTORE_DATABASE_NAME ||
      row.database_role !== env.PRIVACY_RECOVERY_RESTORE_DATABASE_ROLE) {
    throw new Error('privacy_recovery_restore_database_identity_mismatch');
  }

  const privileges = await client.query(
    `SELECT r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication,
            r.rolbypassrls, r.rolcanlogin,
            EXISTS (
              SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid
            ) AS has_role_memberships,
            EXISTS (
              SELECT 1
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname <> 'information_schema'
                 AND n.nspname NOT LIKE 'pg_%'
                 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
                 AND (
                   has_table_privilege(current_user, c.oid, 'INSERT') OR
                   has_table_privilege(current_user, c.oid, 'UPDATE') OR
                   has_table_privilege(current_user, c.oid, 'DELETE') OR
                   has_table_privilege(current_user, c.oid, 'TRUNCATE') OR
                   has_table_privilege(current_user, c.oid, 'REFERENCES') OR
                   has_table_privilege(current_user, c.oid, 'TRIGGER') OR
                   has_any_column_privilege(current_user, c.oid, 'INSERT,UPDATE,REFERENCES')
                 )
            ) AS has_relation_write_privileges,
            EXISTS (
              SELECT 1
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname <> 'information_schema'
                 AND n.nspname NOT LIKE 'pg_%'
                 AND c.relkind = 'S'
                 AND (
                   has_sequence_privilege(current_user, c.oid, 'USAGE') OR
                   has_sequence_privilege(current_user, c.oid, 'UPDATE')
                 )
            ) AS has_sequence_write_privileges,
            EXISTS (
              SELECT 1 FROM pg_namespace n
               WHERE n.nspname <> 'information_schema'
                 AND n.nspname NOT LIKE 'pg_%'
                 AND has_schema_privilege(current_user, n.oid, 'CREATE')
            ) AS has_schema_create_privileges,
            has_database_privilege(current_user, current_database(), 'CREATE')
              AS has_database_create_privilege
       FROM pg_roles r
      WHERE r.rolname = current_user`
  );
  const role = privileges.rows?.[0];
  if (!role ||
      role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolreplication ||
      role.rolbypassrls || !role.rolcanlogin || role.has_role_memberships ||
      role.has_relation_write_privileges || role.has_sequence_write_privileges ||
      role.has_schema_create_privileges || role.has_database_create_privilege) {
    throw new Error('privacy_recovery_restore_database_role_not_read_only');
  }
  return { databaseName: row.database_name, databaseRole: row.database_role, readOnlyRole: true };
}
