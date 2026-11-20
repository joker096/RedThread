import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const guard = path.join(root, 'privacyRecoveryAdmissionGuard.js');

function run(env, shell = 'node --input-type=module -e "import(process.env.GUARD_MODULE).then(m => m.assertPrivacyRecoveryAdmission())"') {
  return spawnSync('bash', ['-c', shell], {
    encoding: 'utf8',
    env: { ...process.env, GUARD_MODULE: guard, ...env }
  });
}

test('production entrypoint guard rejects a direct Node launch without inherited FD 9', async () => {
  const result = run({
    PRIVACY_RECOVERY_REQUIRE_ADMISSION: 'true',
    PRIVACY_RECOVERY_WRITER_LOCK_FILE: '/run/vow-privacy/writers.lock'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires the inherited shared lock on FD 9/);
});

test('production entrypoint guard accepts only the configured live shared lock descriptor', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'vow-admission-node-guard-'));
  try {
    const lock = path.join(temporaryRoot, 'writers.lock');
    await writeFile(lock, '');
    const result = run({
      PRIVACY_RECOVERY_REQUIRE_ADMISSION: 'true',
      PRIVACY_RECOVERY_WRITER_LOCK_FILE: lock
    }, 'exec 9< "$PRIVACY_RECOVERY_WRITER_LOCK_FILE"; flock -s 9; node --input-type=module -e "import(process.env.GUARD_MODULE).then(m => { if (!m.assertPrivacyRecoveryAdmission()) process.exit(2) })"');
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('production entrypoint guard rejects a different lock descriptor', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'vow-admission-node-wrong-lock-'));
  try {
    const lock = path.join(temporaryRoot, 'writers.lock');
    const other = path.join(temporaryRoot, 'other.lock');
    await writeFile(lock, '');
    await writeFile(other, '');
    const result = run({
      PRIVACY_RECOVERY_REQUIRE_ADMISSION: 'true',
      PRIVACY_RECOVERY_WRITER_LOCK_FILE: lock,
      OTHER_LOCK: other
    }, 'exec 9< "$OTHER_LOCK"; flock -s 9; node --input-type=module -e "import(process.env.GUARD_MODULE).then(m => m.assertPrivacyRecoveryAdmission())"');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not reference the configured lock inode/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('production entrypoint guard refuses a durable maintenance marker', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'vow-admission-node-marker-'));
  try {
    const lock = path.join(temporaryRoot, 'writers.lock');
    await writeFile(lock, '');
    await writeFile(lock + '.maintenance', '');
    const result = run({
      PRIVACY_RECOVERY_REQUIRE_ADMISSION: 'true',
      PRIVACY_RECOVERY_WRITER_LOCK_FILE: lock
    }, 'exec 9< "$PRIVACY_RECOVERY_WRITER_LOCK_FILE"; flock -s 9; node --input-type=module -e "import(process.env.GUARD_MODULE).then(m => m.assertPrivacyRecoveryAdmission())"');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /admission is closed for maintenance/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
