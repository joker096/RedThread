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

function clientFor(databaseName = env.PRIVACY_RECOVERY_RESTORE_DATABASE_NAME,
  databaseRole = env.PRIVACY_RECOVERY_RESTORE_DATABASE_ROLE) {
  const calls = [];
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      return { rowCount: 1, rows: [{ database_name: databaseName, database_role: databaseRole }] };
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

test('restore target compares actual PostgreSQL database and role identities', async () => {
  const client = clientFor();
  const result = await assertPrivacyRecoveryRestoreTarget(client, env);
  assert.deepEqual(result, {
    databaseName: env.PRIVACY_RECOVERY_RESTORE_DATABASE_NAME,
    databaseRole: env.PRIVACY_RECOVERY_RESTORE_DATABASE_ROLE
  });
  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0], /current_database\(\).*current_user/);
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

test('restore target refuses missing database identity results', async () => {
  await assert.rejects(
    assertPrivacyRecoveryRestoreTarget({ async query() { return { rows: [] }; } }, env),
    /privacy_recovery_restore_database_identity_mismatch/
  );
});
