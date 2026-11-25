import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPrivacyRecoveryRestoreTarget,
  assertPrivacyRecoveryRestoreTargetConfig
} from './privacyRecoveryTargetGuard.js';

const env = {
  NODE_ENV: 'test',
  PRIVACY_RECOVERY_RESTORE_ISOLATED: 'true',
  PRIVACY_RECOVERY_RESTORE_DATABASE_NAME: 'vow_restore_recovery_01',
  PRIVACY_RECOVERY_RESTORE_DATABASE_ROLE: 'vow_restore_runner',
  PRIVACY_RECOVERY_RESTORE_CONFIRMATION: 'ISOLATED_RESTORE_ONLY'
};

const readonlyRole = {
  rolsuper: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolreplication: false,
  rolbypassrls: false,
  rolcanlogin: true,
  has_role_memberships: false,
  has_relation_write_privileges: false,
  has_column_write_privileges: false,
  has_sequence_write_privileges: false,
  has_schema_create_privileges: false,
  has_database_create_privilege: false,
  has_database_temp_privilege: false,
  has_existing_temp_schema: false
};

function clientFor(databaseName = env.PRIVACY_RECOVERY_RESTORE_DATABASE_NAME,
  databaseRole = env.PRIVACY_RECOVERY_RESTORE_DATABASE_ROLE, role = readonlyRole) {
  const calls = [];
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      if (calls.length === 1) {
        return { rowCount: 1, rows: [{ database_name: databaseName, database_role: databaseRole }] };
      }
      return { rowCount: 1, rows: [role] };
    }
  };
}

test('restore target requires a dedicated database name, role and explicit operator confirmation', () => {
  assert.doesNotThrow(() => assertPrivacyRecoveryRestoreTargetConfig(env));
  for (const overrides of [
    { PRIVACY_RECOVERY_RESTORE_DATABASE_NAME: 'production' },
    { PRIVACY_RECOVERY_RESTORE_DATABASE_ROLE: 'app_user' },
    { PRIVACY_RECOVERY_RESTORE_CONFIRMATION: '' },
    { PRIVACY_RECOVERY_RESTORE_ISOLATED: 'false' },
    { NODE_ENV: 'production' }
  ]) {
    assert.throws(
      () => assertPrivacyRecoveryRestoreTargetConfig({ ...env, ...overrides }),
      /privacy_recovery_restore_target_not_explicitly_configured/
    );
  }
});

test('restore target verifies database identity and effective read-only role privileges', async () => {
  const client = clientFor();
  const result = await assertPrivacyRecoveryRestoreTarget(client, env);
  assert.deepEqual(result, {
    databaseName: env.PRIVACY_RECOVERY_RESTORE_DATABASE_NAME,
    databaseRole: env.PRIVACY_RECOVERY_RESTORE_DATABASE_ROLE,
    readOnlyRole: true
  });
  assert.equal(client.calls.length, 2);
  assert.match(client.calls[0], /current_database\(\).*current_user/);
  assert.match(client.calls[1], /has_table_privilege/);
  assert.match(client.calls[1], /has_any_column_privilege/);
  assert.match(client.calls[1], /has_sequence_privilege/);
  assert.match(client.calls[1], /has_database_privilege\(current_user, current_database\(\), 'TEMP'\)/);
  assert.match(client.calls[1], /pg_my_temp_schema\(\)/);
});

test('restore target refuses a production database or application role even when configuration claims isolation', async () => {
  for (const client of [
    clientFor('vow_production', 'vow_restore_runner'),
    clientFor('vow_restore_recovery_01', 'vow_api')
  ]) {
    await assert.rejects(
      assertPrivacyRecoveryRestoreTarget(client, env),
      /privacy_recovery_restore_database_identity_mismatch/
    );
  }
});

test('restore target refuses a role with any elevated or write capability', async () => {
  const dangerous = [
    { rolsuper: true },
    { rolcreatedb: true },
    { rolcreaterole: true },
    { rolreplication: true },
    { rolbypassrls: true },
    { rolcanlogin: false },
    { has_role_memberships: true },
    { has_relation_write_privileges: true },
    { has_column_write_privileges: true },
    { has_sequence_write_privileges: true },
    { has_schema_create_privileges: true },
    { has_database_create_privilege: true },
    { has_database_temp_privilege: true },
    { has_existing_temp_schema: true }
  ];
  for (const override of dangerous) {
    await assert.rejects(
      assertPrivacyRecoveryRestoreTarget(clientFor(
        env.PRIVACY_RECOVERY_RESTORE_DATABASE_NAME,
        env.PRIVACY_RECOVERY_RESTORE_DATABASE_ROLE,
        { ...readonlyRole, ...override }
      ), env),
      /privacy_recovery_restore_database_role_not_read_only/
    );
  }
});

test('restore target refuses missing database identity or role privilege results', async () => {
  await assert.rejects(
    assertPrivacyRecoveryRestoreTarget({
      async query() { return { rows: [] }; }
    }, env),
    /privacy_recovery_restore_database_identity_mismatch/
  );
  const client = clientFor();
  client.query = async sql => sql.includes('current_database')
    ? { rows: [{ database_name: env.PRIVACY_RECOVERY_RESTORE_DATABASE_NAME, database_role: env.PRIVACY_RECOVERY_RESTORE_DATABASE_ROLE }] }
    : { rows: [] };
  await assert.rejects(
    assertPrivacyRecoveryRestoreTarget(client, env),
    /privacy_recovery_restore_database_role_not_read_only/
  );
});
