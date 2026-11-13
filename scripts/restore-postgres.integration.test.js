import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from 'pg';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const backupScript = path.join(scriptsDir, 'backup-postgres.sh');
const restoreScript = path.join(scriptsDir, 'restore-postgres.sh');
const stagingConfirmation = 'I_UNDERSTAND_THIS_IS_A_DISPOSABLE_STAGING_DATABASE';

function run(command, args, env) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(result.status, 0, result.stderr || result.stdout || `${command} exited with ${result.status}`);
  return result;
}

function databaseUrl(databaseName) {
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

test('PostgreSQL backup restores through real age and pg_restore into an isolated empty database', {
  skip: !process.env.DATABASE_URL ? 'DATABASE_URL is not configured' : false,
  timeout: 120_000
}, async () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const sourceDatabase = `vow_restore_src_${suffix}`;
  const targetDatabase = `vow_restore_dst_${suffix}`;
  const sourceUrl = databaseUrl(sourceDatabase);
  const targetUrl = databaseUrl(targetDatabase);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'vow-postgres-real-restore-'));
  const backupDir = path.join(temporaryRoot, 'backups');
  const identityFile = path.join(temporaryRoot, 'age-identity.txt');
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  let source;
  let target;
  let sourceCreated = false;
  let targetCreated = false;

  try {
    run('age-keygen', ['-o', identityFile]);
    await chmod(identityFile, 0o600);
    const identity = await readFile(identityFile, 'utf8');
    const recipient = identity.match(/^# public key: (age1[0-9a-z]+)$/m)?.[1];
    assert.ok(recipient, 'age-keygen must produce a public recipient');

    await admin.connect();
    await admin.query(`CREATE DATABASE "${sourceDatabase}"`);
    sourceCreated = true;
    await admin.query(`CREATE DATABASE "${targetDatabase}"`);
    targetCreated = true;

    source = new Client({ connectionString: sourceUrl });
    await source.connect();
    await source.query('CREATE TABLE restore_drill_fixture (id integer PRIMARY KEY, payload text NOT NULL)');
    await source.query(
      'INSERT INTO restore_drill_fixture (id, payload) VALUES ($1, $2), ($3, $4)',
      [1, 'first-private-fixture', 2, 'second-private-fixture']
    );
    await source.end();
    source = undefined;

    run('bash', [backupScript], {
      DATABASE_URL: sourceUrl,
      BACKUP_AGE_RECIPIENT: recipient,
      BACKUP_DIR: backupDir,
      BACKUP_RETENTION_DAYS: '30'
    });
    const artifacts = await readdir(backupDir);
    const archiveName = artifacts.find(name => name.endsWith('.dump.age'));
    assert.ok(archiveName, 'encrypted PostgreSQL backup should exist');
    assert.ok(artifacts.includes(`${archiveName}.sha256`), 'backup checksum should exist');
    const encrypted = await readFile(path.join(backupDir, archiveName));
    assert.equal(encrypted.includes(Buffer.from('first-private-fixture')), false,
      'encrypted archive must not contain plaintext database fixture');

    run('bash', [restoreScript], {
      ARCHIVE_FILE: path.join(backupDir, archiveName),
      AGE_IDENTITY_FILE: identityFile,
      RESTORE_DATABASE_URL: targetUrl,
      RESTORE_CONFIRM_STAGING: stagingConfirmation
    });

    target = new Client({ connectionString: targetUrl });
    await target.connect();
    const restored = await target.query(
      'SELECT id, payload FROM restore_drill_fixture ORDER BY id'
    );
    assert.deepEqual(restored.rows, [
      { id: 1, payload: 'first-private-fixture' },
      { id: 2, payload: 'second-private-fixture' }
    ]);

    await target.query('CREATE TABLE restore_target_sentinel (id integer PRIMARY KEY)');
    await target.query('INSERT INTO restore_target_sentinel (id) VALUES (99)');
    await target.end();
    target = undefined;

    const refused = spawnSync('bash', [restoreScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ARCHIVE_FILE: path.join(backupDir, archiveName),
        AGE_IDENTITY_FILE: identityFile,
        RESTORE_DATABASE_URL: targetUrl,
        RESTORE_CONFIRM_STAGING: stagingConfirmation
      }
    });
    assert.notEqual(refused.status, 0, 'a non-empty target must be refused');
    target = new Client({ connectionString: targetUrl });
    await target.connect();
    const sentinel = await target.query('SELECT id FROM restore_target_sentinel');
    assert.deepEqual(sentinel.rows, [{ id: 99 }], 'refused restore must leave existing data untouched');
    await target.end();
    target = undefined;
  } finally {
    if (source) await source.end().catch(() => {});
    if (target) await target.end().catch(() => {});
    if (admin._connected) {
      if (targetCreated) await admin.query(`DROP DATABASE IF EXISTS "${targetDatabase}" WITH (FORCE)`).catch(() => {});
      if (sourceCreated) await admin.query(`DROP DATABASE IF EXISTS "${sourceDatabase}" WITH (FORCE)`).catch(() => {});
      await admin.end().catch(() => {});
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
