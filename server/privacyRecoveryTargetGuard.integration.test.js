import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { assertPrivacyRecoveryRestoreTarget } from './privacyRecoveryTargetGuard.js';

const adminUrl = process.env.DATABASE_URL;

function quoteIdentifier(value) {
  return '"' + value.replaceAll('"', '""') + '"';
}

function quoteLiteral(value) {\n  return "'" + value.replaceAll("'", "''") + "'";\n}\n\nfunction roleUrl(databaseUrl, databaseName, roleName, password) {
  const url = new URL(databaseUrl);
  url.pathname = '/' + databaseName;
  url.username = roleName;
  url.password = password;
  return url.toString();
}

test('PostgreSQL 16 verifier rejects TEMP grants and pre-existing temporary schemas', {
  skip: !adminUrl ? 'DATABASE_URL is not configured' : false,
  timeout: 60_000
}, async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const databaseName = 'vow_restore_temp_' + suffix;
  const roleName = 'vow_restore_temp_' + suffix;
  const password = randomUUID() + 'Aa1!';
  const databaseIdent = quoteIdentifier(databaseName);
  const roleIdent = quoteIdentifier(roleName);
  const admin = new Client({ connectionString: adminUrl });
  let adminConnected = false;
  let databaseCreated = false;
  let roleCreated = false;
  let verifier;

  const env = {
    NODE_ENV: 'test',
    PRIVACY_RECOVERY_RESTORE_ISOLATED: 'true',
    PRIVACY_RECOVERY_RESTORE_DATABASE_NAME: databaseName,
    PRIVACY_RECOVERY_RESTORE_DATABASE_ROLE: roleName,
    PRIVACY_RECOVERY_RESTORE_CONFIRMATION: 'ISOLATED_RESTORE_ONLY'
  };

  try {
    await admin.connect();
    adminConnected = true;
    await admin.query('CREATE DATABASE ' + databaseIdent);
    databaseCreated = true;
    await admin.query('CREATE ROLE ' + roleIdent + ' LOGIN PASSWORD ' + quoteLiteral(password));
    roleCreated = true;
    await admin.query('REVOKE TEMPORARY ON DATABASE ' + databaseIdent + ' FROM PUBLIC');
    await admin.query('GRANT CONNECT ON DATABASE ' + databaseIdent + ' TO ' + roleIdent);

    verifier = new Client({
      connectionString: roleUrl(adminUrl, databaseName, roleName, password)
    });
    await verifier.connect();

    const accepted = await assertPrivacyRecoveryRestoreTarget(verifier, env);
    assert.deepEqual(accepted, {
      databaseName,
      databaseRole: roleName,
      readOnlyRole: true
    });

    await admin.query('GRANT TEMPORARY ON DATABASE ' + databaseIdent + ' TO ' + roleIdent);
    await assert.rejects(
      assertPrivacyRecoveryRestoreTarget(verifier, env),
      /privacy_recovery_restore_database_role_not_read_only/
    );

    await verifier.query('CREATE TEMP TABLE verifier_shadow_fixture (id integer)');
    await admin.query('REVOKE TEMPORARY ON DATABASE ' + databaseIdent + ' FROM ' + roleIdent);
    await assert.rejects(
      assertPrivacyRecoveryRestoreTarget(verifier, env),
      /privacy_recovery_restore_database_role_not_read_only/
    );
  } finally {
    if (verifier) await verifier.end().catch(() => {});
    if (adminConnected) {
      if (databaseCreated) {
        await admin.query('REVOKE CONNECT ON DATABASE ' + databaseIdent + ' FROM PUBLIC').catch(() => {});
        await admin.query('DROP DATABASE IF EXISTS ' + databaseIdent + ' WITH (FORCE)').catch(() => {});
      }
      if (roleCreated) await admin.query('DROP ROLE IF EXISTS ' + roleIdent).catch(() => {});
      await admin.end().catch(() => {});
    }
  }
});
