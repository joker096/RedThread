import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from 'pg';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const backupBundleScript = path.join(scriptsDir, 'backup-bundle.sh');
const admissionScript = path.join(scriptsDir, 'privacy-recovery-admission.sh');
const restoreBundleScript = path.join(scriptsDir, 'restore-bundle.sh');
const stagingConfirmation = 'I_UNDERSTAND_THIS_IS_A_DISPOSABLE_STAGING_DATABASE';

function run(command, args, env, timeout = 150_000) {
  const pg16Bin = '/usr/lib/postgresql/16/bin';
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, PATH: pg16Bin + ':' + (process.env.PATH || ''), ...env }
  });
  assert.equal(result.status, 0,
    result.stderr || result.stdout || (command + ' exited with ' + result.status + ' (signal ' + result.signal + ')'));
  return result;
}

const sharedGid = 65534;
const writerUid = process.getuid?.() === 0 ? sharedGid : process.getuid();
const writerPrimaryGid = process.getgid?.() === 0 ? sharedGid : process.getgid();
const sudo = process.getuid?.() === 0 ? [] : ['sudo', '-n'];

function rootRun(args) {
  return spawnSync(sudo.length ? 'sudo' : args[0], sudo.length ? ['-n', ...args] : args.slice(1), { encoding: 'utf8' });
}

function runAsWriter(command, args, env = {}, timeout = 150_000) {
  const vars = Object.entries({
    ...env,
    PATH: '/usr/lib/postgresql/16/bin:' + (process.env.PATH || ''),
    PRIVACY_RECOVERY_WRITER_GID: String(sharedGid)
  }).map(([key, value]) => `${key}=${value}`);
  const argv = [...sudo, 'setpriv', '--reuid', String(writerUid), '--regid', String(writerPrimaryGid),
    '--groups', String(sharedGid), '--', 'env', ...vars, command, ...args];
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, PATH: '/usr/lib/postgresql/16/bin:' + (process.env.PATH || '') }
  });
  assert.equal(result.status, 0,
    result.stderr || result.stdout || (command + ' exited with ' + result.status + ' (signal ' + result.signal + ')'));
  return result;
}

function databaseUrl(databaseName) {
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/' + databaseName;
  return url.toString();
}

function commandAvailable(command) {
  return spawnSync('bash', ['-lc', 'command -v ' + command], { encoding: 'utf8' }).status === 0;
}

test('backup artifact pair restores PostgreSQL and private media into isolated staging', {
  skip: !process.env.DATABASE_URL ? 'DATABASE_URL is not configured'
    : (!commandAvailable('age') || !commandAvailable('age-keygen') || !commandAvailable('tar')
      ? 'age, age-keygen and tar are required for the real coordinated restore drill'
      : false),
  timeout: 180_000
}, async () => {
  const suffix = process.pid + '_' + Date.now();
  const snapshotId = 'ci_' + suffix;
  const sourceDatabase = 'vow_bundle_src_' + suffix;
  const targetDatabase = 'vow_restore_dst_' + suffix;
  const sourceUrl = databaseUrl(sourceDatabase);
  const targetUrl = databaseUrl(targetDatabase);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'vow-coordinated-backup-'));
  const backupRoot = path.join(temporaryRoot, 'bundles');
  const mediaRoot = path.join(temporaryRoot, 'private-media');
  const restoredMediaParent = path.join(temporaryRoot, 'restored');
  const restoredMedia = path.join(restoredMediaParent, 'private-media');
  const identityFile = path.join(temporaryRoot, 'age-identity.txt');
  const lockDir = path.join(temporaryRoot, 'admission');
  const lockFile = path.join(lockDir, 'writers.lock');
  const drainFile = path.join(temporaryRoot, 'drain');
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  let adminConnected = false;
  let sourceCreated = false;
  let targetCreated = false;
  let source;
  let target;

  try {
    run('age-keygen', ['-o', identityFile], {});
    await chmod(identityFile, 0o600);
    const identity = await readFile(identityFile, 'utf8');
    const recipient = identity.match(/^# public key: (age1[0-9a-z]+)$/m)?.[1];
    assert.ok(recipient, 'age-keygen must produce an age recipient');

    await writeFile(drainFile, '#!/usr/bin/env bash\nset -eu\nexit 0\n');
    await chmod(drainFile, 0o700);
    await mkdir(backupRoot, { mode: 0o700 });
    await mkdir(mediaRoot, { mode: 0o700 });
    await mkdir(path.join(mediaRoot, 'voice'), { recursive: true, mode: 0o700 });
    await mkdir(restoredMediaParent, { mode: 0o700 });
    const lockDirCreate = rootRun(['install', '-d', '-o', '0', '-g', String(sharedGid), '-m', '2750', lockDir]);
    assert.equal(lockDirCreate.status, 0, lockDirCreate.stderr);
    const lockCreate = rootRun(['install', '-o', '0', '-g', String(sharedGid), '-m', '0640', '/dev/null', lockFile]);
    assert.equal(lockCreate.status, 0, lockCreate.stderr);
    const drainOwner = rootRun(['chown', '0:0', drainFile]);
    assert.equal(drainOwner.status, 0, drainOwner.stderr);
    const drainMode = rootRun(['chmod', '0755', drainFile]);
    assert.equal(drainMode.status, 0, drainMode.stderr);
    if (process.getuid?.() === 0) {
      const rootMode = rootRun(['chmod', '0711', temporaryRoot]);
      assert.equal(rootMode.status, 0, rootMode.stderr);
    }
    const photoFixture = Buffer.from('synthetic-private-photo-fixture');
    const voiceFixture = Buffer.from([0, 1, 2, 3, 127, 128, 254, 255]);
    await writeFile(path.join(mediaRoot, 'photo-fixture.bin'), photoFixture, { mode: 0o600 });
    await writeFile(path.join(mediaRoot, 'voice', 'voice-fixture.bin'), voiceFixture, { mode: 0o600 });
    for (const target of [backupRoot, restoredMediaParent]) {
      const owner = rootRun(['chown', `${writerUid}:${sharedGid}`, target]);
      assert.equal(owner.status, 0, owner.stderr);
    }
    const mediaOwner = rootRun(['chown', '-R', `${writerUid}:${sharedGid}`, mediaRoot]);
    assert.equal(mediaOwner.status, 0, mediaOwner.stderr);

    await admin.connect();
    adminConnected = true;
    await admin.query('CREATE DATABASE "' + sourceDatabase + '"');
    sourceCreated = true;
    await admin.query('CREATE DATABASE "' + targetDatabase + '"');
    targetCreated = true;

    source = new Client({ connectionString: sourceUrl });
    await source.connect();
    await source.query('CREATE TABLE coordinated_restore_fixture (id integer PRIMARY KEY, payload text NOT NULL)');
    await source.query(
      'INSERT INTO coordinated_restore_fixture (id, payload) VALUES ($1, $2), ($3, $4)',
      [1, 'database-fixture-one', 2, 'database-fixture-two']
    );
    await source.end();
    source = undefined;

    runAsWriter('bash', [admissionScript, 'writer', '--', 'bash', backupBundleScript], {
      DATABASE_URL: sourceUrl,
      PRIVATE_MEDIA_DIR: mediaRoot,
      BACKUP_AGE_RECIPIENT: recipient,
      BACKUP_DIR: backupRoot,
      BACKUP_SNAPSHOT_ID: snapshotId,
      BACKUP_RETENTION_DAYS: '30',
      PRIVACY_RECOVERY_WRITER_LOCK_FILE: lockFile
    });
    const bundleDir = path.join(backupRoot, snapshotId);
    const manifest = await readFile(path.join(bundleDir, 'manifest.txt'), 'utf8');
    assert.ok(manifest.includes('format=vow-backup-bundle-v2'));
    assert.ok(manifest.includes('snapshot_id=' + snapshotId));
    assert.ok(manifest.includes('snapshot_consistency=best_effort_non_atomic'));
    assert.ok(manifest.includes('postgres_archive=postgres/vow-postgres-' + snapshotId + '.dump.age'));
    assert.ok(manifest.includes('private_media_archive=private-media/vow-private-media-' + snapshotId + '.tar.age'));
    assert.ok((await readFile(path.join(bundleDir, 'manifest.sha256'), 'utf8')).includes('manifest.txt'));

    run('bash', [restoreBundleScript], {
      BACKUP_BUNDLE_DIR: bundleDir,
      AGE_IDENTITY_FILE: identityFile,
      RESTORE_DATABASE_URL: targetUrl,
      RESTORE_CONFIRM_STAGING: stagingConfirmation,
      RESTORE_DESTINATION: restoredMedia
    });

    target = new Client({ connectionString: targetUrl });
    await target.connect();
    const rows = await target.query('SELECT id, payload FROM coordinated_restore_fixture ORDER BY id');
    assert.deepEqual(rows.rows, [
      { id: 1, payload: 'database-fixture-one' },
      { id: 2, payload: 'database-fixture-two' }
    ]);
    await target.end();
    target = undefined;

    assert.deepEqual(await readFile(path.join(restoredMedia, 'photo-fixture.bin')), photoFixture);
    assert.deepEqual(await readFile(path.join(restoredMedia, 'voice', 'voice-fixture.bin')), voiceFixture);
    assert.equal(await readFile(path.join(restoredMedia, '.vow-restore-pending'), 'utf8'), '',
      'restored media must remain blocked pending privacy reconciliation');
  } finally {
    if (source) await source.end().catch(() => {});
    if (target) await target.end().catch(() => {});
    if (adminConnected) {
      if (targetCreated) await admin.query('DROP DATABASE IF EXISTS "' + targetDatabase + '" WITH (FORCE)').catch(() => {});
      if (sourceCreated) await admin.query('DROP DATABASE IF EXISTS "' + sourceDatabase + '" WITH (FORCE)').catch(() => {});
      await admin.end().catch(() => {});
    }
    rootRun(['rm', '-rf', '--', temporaryRoot]);
  }
});


test('coordinated restore rejects a tampered encrypted artifact before opening staging targets', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'vow-backup-tamper-'));
  const bundleDir = path.join(temporaryRoot, 'bundle');
  const identityFile = path.join(temporaryRoot, 'age-identity.txt');
  const postgresDir = path.join(bundleDir, 'postgres');
  const mediaDir = path.join(bundleDir, 'private-media');
  const postgresName = 'vow-postgres-tamper_fixture.dump.age';
  const mediaName = 'vow-private-media-tamper_fixture.tar.age';
  const postgresPath = path.join(postgresDir, postgresName);
  const mediaPath = path.join(mediaDir, mediaName);
  const destination = path.join(temporaryRoot, 'restore-target');
  try {
    await mkdir(postgresDir, { recursive: true, mode: 0o700 });
    await mkdir(mediaDir, { recursive: true, mode: 0o700 });
    await writeFile(identityFile, 'synthetic-age-identity', { mode: 0o600 });
    await writeFile(postgresPath, 'original-encrypted-postgres-fixture', { mode: 0o600 });
    await writeFile(mediaPath, 'original-encrypted-media-fixture', { mode: 0o600 });
    const postgresDigest = createHash('sha256').update(await readFile(postgresPath)).digest('hex');
    const mediaDigest = createHash('sha256').update(await readFile(mediaPath)).digest('hex');
    await writeFile(postgresPath + '.sha256', postgresDigest + '  ' + postgresName + '\n', { mode: 0o600 });
    await writeFile(mediaPath + '.sha256', mediaDigest + '  ' + mediaName + '\n', { mode: 0o600 });
    const manifest = [
      'format=vow-backup-bundle-v2',
      'snapshot_id=tamper_fixture',
      'snapshot_consistency=best_effort_non_atomic',
      'postgres_archive=postgres/' + postgresName,
      'postgres_sha256=' + postgresDigest,
      'private_media_archive=private-media/' + mediaName,
      'private_media_sha256=' + mediaDigest,
      ''
    ].join('\n');
    await writeFile(path.join(bundleDir, 'manifest.txt'), manifest, { mode: 0o600 });
    const manifestDigest = createHash('sha256').update(manifest).digest('hex');
    await writeFile(path.join(bundleDir, 'manifest.sha256'), manifestDigest + '  manifest.txt\n', { mode: 0o600 });

    // Simulate corruption after the signed-off bundle manifest was produced.
    await writeFile(postgresPath, 'tampered-encrypted-postgres-fixture', { mode: 0o600 });
    const result = spawnSync('bash', [restoreBundleScript], {
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        BACKUP_BUNDLE_DIR: bundleDir,
        AGE_IDENTITY_FILE: identityFile,
        RESTORE_DATABASE_URL: 'postgres://restore.invalid/never_opened',
        RESTORE_CONFIRM_STAGING: stagingConfirmation,
        RESTORE_DESTINATION: destination
      }
    });
    assert.notEqual(result.status, 0, 'restore must fail closed for a modified archive');
    assert.match(result.stderr, /artifact checksum does not match its manifest/);
    await assert.rejects(readFile(path.join(destination, '.vow-restore-pending')));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});


test('restore rejects a false atomic-snapshot declaration before touching staging targets', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'vow-backup-consistency-'));
  const bundleDir = path.join(temporaryRoot, 'bundle');
  const identityFile = path.join(temporaryRoot, 'age-identity.txt');
  const postgresDir = path.join(bundleDir, 'postgres');
  const mediaDir = path.join(bundleDir, 'private-media');
  const postgresName = 'vow-postgres-consistency_fixture.dump.age';
  const mediaName = 'vow-private-media-consistency_fixture.tar.age';
  const destination = path.join(temporaryRoot, 'restore-target');
  try {
    await mkdir(postgresDir, { recursive: true, mode: 0o700 });
    await mkdir(mediaDir, { recursive: true, mode: 0o700 });
    await writeFile(identityFile, 'synthetic-age-identity', { mode: 0o600 });
    await writeFile(path.join(postgresDir, postgresName), 'synthetic-postgres-archive', { mode: 0o600 });
    await writeFile(path.join(mediaDir, mediaName), 'synthetic-media-archive', { mode: 0o600 });
    const manifest = [
      'format=vow-backup-bundle-v2',
      'snapshot_id=consistency_fixture',
      'snapshot_consistency=atomic',
      'postgres_archive=postgres/' + postgresName,
      'postgres_sha256=' + '0'.repeat(64),
      'private_media_archive=private-media/' + mediaName,
      'private_media_sha256=' + '0'.repeat(64),
      ''
    ].join('\n');
    await writeFile(path.join(bundleDir, 'manifest.txt'), manifest, { mode: 0o600 });
    const manifestDigest = createHash('sha256').update(manifest).digest('hex');
    await writeFile(path.join(bundleDir, 'manifest.sha256'), manifestDigest + '  manifest.txt\n', { mode: 0o600 });

    const result = spawnSync('bash', [restoreBundleScript], {
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        BACKUP_BUNDLE_DIR: bundleDir,
        AGE_IDENTITY_FILE: identityFile,
        RESTORE_DATABASE_URL: 'postgres://invalid/staging',
        RESTORE_CONFIRM_STAGING: stagingConfirmation,
        RESTORE_DESTINATION: destination
      }
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /consistency declaration is invalid/);
    await assert.rejects(readFile(destination));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
