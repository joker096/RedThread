import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const adminUrl = process.env.DATABASE_URL;

function quoteIdentifier(value) {
  return '"' + value.replaceAll('"', '""') + '"';
}

function quoteLiteral(value) {
  return "'" + value.replaceAll("'", "''") + "'";
}

function roleUrl(databaseUrl, databaseName, roleName, password) {
  const url = new URL(databaseUrl);
  url.pathname = '/' + databaseName;
  url.username = roleName;
  url.password = password;
  return url.toString();
}

test('restore LOGIN can SET ROLE to a NOLOGIN owner without inheriting its privileges; verifier stays read-only', {
  skip: !adminUrl ? 'DATABASE_URL is not configured' : false,
  timeout: 60_000
}, async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 18);
  const databaseName = 'vow_restore_roles_' + suffix;
  const ownerName = 'vow_restore_owner_' + suffix;
  const restoreName = 'vow_restore_login_' + suffix;
  const verifierName = 'vow_restore_verify_' + suffix;
  const restorePassword = randomUUID() + 'Aa1!';
  const verifierPassword = randomUUID() + 'Bb2!';
  const databaseIdent = quoteIdentifier(databaseName);
  const ownerIdent = quoteIdentifier(ownerName);
  const restoreIdent = quoteIdentifier(restoreName);
  const verifierIdent = quoteIdentifier(verifierName);
  const admin = new Client({ connectionString: adminUrl });
  let adminConnected = false;
  let databaseCreated = false;
  let ownerCreated = false;
  let restoreCreated = false;
  let verifierCreated = false;
  let restore;
  let verifier;
  let targetAdmin;

  try {
    await admin.connect();
    adminConnected = true;
    await admin.query('CREATE ROLE ' + ownerIdent + ' NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    ownerCreated = true;
    await admin.query('CREATE ROLE ' + restoreIdent + ' LOGIN PASSWORD ' + quoteLiteral(restorePassword) +
      ' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    restoreCreated = true;
    await admin.query('CREATE ROLE ' + verifierIdent + ' LOGIN PASSWORD ' + quoteLiteral(verifierPassword) +
      ' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    verifierCreated = true;
    await admin.query('GRANT ' + ownerIdent + ' TO ' + restoreIdent + ' WITH INHERIT FALSE, SET TRUE');
    await admin.query('CREATE DATABASE ' + databaseIdent + ' OWNER ' + ownerIdent);
    databaseCreated = true;
    await admin.query('REVOKE TEMPORARY ON DATABASE ' + databaseIdent + ' FROM PUBLIC');
    targetAdmin = new Client({ connectionString: roleUrl(adminUrl, databaseName, new URL(adminUrl).username, new URL(adminUrl).password) });
    await targetAdmin.connect();
    await targetAdmin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');

    restore = new Client({
      connectionString: roleUrl(adminUrl, databaseName, restoreName, restorePassword)
    });
    verifier = new Client({
      connectionString: roleUrl(adminUrl, databaseName, verifierName, verifierPassword)
    });
    await restore.connect();
    await verifier.connect();

    const restoreIdentity = await restore.query(
      'SELECT current_user AS role, pg_has_role(current_user, $1, \'MEMBER\') AS member, ' +
      'pg_has_role(current_user, $1, \'USAGE\') AS inherited FROM pg_roles WHERE rolname = current_user',
      [ownerName]
    );
    assert.deepEqual(restoreIdentity.rows, [{ role: restoreName, member: true, inherited: false }]);

    await assert.rejects(
      restore.query('CREATE TABLE public.restore_role_must_be_assumed (id integer)'),
      error => error.code === '42501'
    );

    await restore.query('SET ROLE ' + ownerIdent);
    const ownerIdentity = await restore.query('SELECT current_user');
    assert.equal(ownerIdentity.rows[0].current_user, ownerName);
    await restore.query('CREATE TABLE public.restore_role_fixture (id integer PRIMARY KEY, payload text NOT NULL)');
    await restore.query('INSERT INTO public.restore_role_fixture (id, payload) VALUES (1, \'owner-created\')');
    await restore.query('GRANT SELECT ON public.restore_role_fixture TO ' + verifierIdent);
    await restore.query('RESET ROLE');

    const ownerCheck = await admin.query(
      'SELECT r.rolname, r.rolcanlogin, c.relowner = r.oid AS owns_fixture ' +
      'FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ' +
      'WHERE r.rolname = $1 AND n.nspname = \'public\' AND c.relname = \'restore_role_fixture\'',
      [ownerName]
    );
    assert.deepEqual(ownerCheck.rows, [{ rolname: ownerName, rolcanlogin: false, owns_fixture: true }]);

    await assert.rejects(
      restore.query('INSERT INTO public.restore_role_fixture (id, payload) VALUES (2, \'restore-login-must-not-write\')'),
      error => error.code === '42501'
    );

    const verifierIdentity = await verifier.query(
      'SELECT current_user AS role, pg_has_role(current_user, $1, \'MEMBER\') AS owner_member, ' +
      'has_database_privilege(current_user, current_database(), \'TEMP\') AS can_temp, ' +
      'has_schema_privilege(current_user, \'public\', \'CREATE\') AS can_create_schema',
      [ownerName]
    );
    assert.deepEqual(verifierIdentity.rows, [{
      role: verifierName,
      owner_member: false,
      can_temp: false,
      can_create_schema: false
    }]);

    const visible = await verifier.query('SELECT id, payload FROM public.restore_role_fixture ORDER BY id');
    assert.deepEqual(visible.rows, [{ id: 1, payload: 'owner-created' }]);
    await assert.rejects(
      verifier.query('INSERT INTO public.restore_role_fixture (id, payload) VALUES (3, \'verifier-must-not-write\')'),
      error => error.code === '42501'
    );
    await assert.rejects(
      verifier.query('CREATE TEMP TABLE verifier_temp_forbidden (id integer)'),
      error => error.code === '42501'
    );
    await assert.rejects(
      verifier.query('SET ROLE ' + ownerIdent),
      error => error.code === '42501'
    );
  } finally {
    if (restore) await restore.end().catch(() => {});
    if (verifier) await verifier.end().catch(() => {});
    if (targetAdmin) await targetAdmin.end().catch(() => {});
    if (adminConnected) {
      if (databaseCreated) {
        await admin.query('REVOKE CONNECT ON DATABASE ' + databaseIdent + ' FROM PUBLIC').catch(() => {});
        await admin.query('DROP DATABASE IF EXISTS ' + databaseIdent + ' WITH (FORCE)').catch(() => {});
      }
      if (restoreCreated) await admin.query('REVOKE ' + ownerIdent + ' FROM ' + restoreIdent).catch(() => {});
      if (restoreCreated) await admin.query('DROP OWNED BY ' + restoreIdent).catch(() => {});
      if (verifierCreated) await admin.query('DROP OWNED BY ' + verifierIdent).catch(() => {});
      if (ownerCreated) await admin.query('DROP OWNED BY ' + ownerIdent).catch(() => {});
      if (restoreCreated) await admin.query('DROP ROLE IF EXISTS ' + restoreIdent).catch(() => {});
      if (verifierCreated) await admin.query('DROP ROLE IF EXISTS ' + verifierIdent).catch(() => {});
      if (ownerCreated) await admin.query('DROP ROLE IF EXISTS ' + ownerIdent).catch(() => {});
      await admin.end().catch(() => {});
    }
  }
});
