import 'dotenv/config';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BACKUP_SETS = Object.freeze([
  { name: 'postgres', directoryEnv: 'OPS_POSTGRES_BACKUP_DIR', pattern: /^vow-postgres-.*\.dump\.age$/ },
  { name: 'privatePhoto', directoryEnv: 'OPS_PRIVATE_PHOTO_BACKUP_DIR', pattern: /^vow-private-media-.*\.tar\.age$/ },
  { name: 'privateVoice', directoryEnv: 'OPS_PRIVATE_VOICE_BACKUP_DIR', pattern: /^vow-private-media-.*\.tar\.age$/ }
]);

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

/**
 * Authenticates an age archive and validates its plaintext container through a
 * streaming pipe. Decrypted bytes are never written to disk or retained here.
 */
export async function validateEncryptedArchive(archivePath, identityPath, format) {
  const identityInfo = await lstat(identityPath);
  if (!identityInfo.isFile() || identityInfo.isSymbolicLink()) {
    throw new Error('backup_identity_not_a_regular_file');
  }
  if (format !== 'postgres' && format !== 'tar') {
    throw new Error('backup_archive_format_unsupported');
  }

  const decrypt = spawn('age', ['--decrypt', '--identity', identityPath, archivePath], {
    stdio: ['ignore', 'pipe', 'ignore']
  });
  const validator = format === 'postgres'
    ? spawn('pg_restore', ['--list'], { stdio: ['pipe', 'ignore', 'ignore'] })
    : spawn('tar', ['--list', '--file=-'], { stdio: ['pipe', 'ignore', 'ignore'] });

  // A validator may exit early on malformed input; consume EPIPE without
  // leaking a stream error while still requiring both processes to succeed.
  validator.stdin.on('error', () => {});
  decrypt.stdout.pipe(validator.stdin);

  let decryptResult;
  let validatorResult;
  try {
    [decryptResult, validatorResult] = await Promise.all([
      waitForExit(decrypt),
      waitForExit(validator)
    ]);
  } catch {
    decrypt.kill();
    validator.kill();
    throw new Error('backup_crypto_validator_unavailable_or_failed');
  }

  if (decryptResult.code !== 0 || validatorResult.code !== 0) {
    throw new Error('backup_archive_authentication_or_format_invalid');
  }
  return true;
}

export async function verifyEncryptedBackupDirectory(directory, {
  pattern,
  name,
  ageIdentityFile,
  archiveValidator = validateEncryptedArchive
}) {
  if (!directory) return { name, status: 'not_configured', checked: 0, failures: [] };
  const root = path.resolve(directory);
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch (error) {
    return { name, status: 'failed', checked: 0, failures: [error?.code === 'ENOENT' ? 'backup_directory_missing' : 'backup_directory_unreadable'] };
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    return { name, status: 'failed', checked: 0, failures: ['backup_directory_not_a_real_directory'] };
  }

  const failures = [];
  let checked = 0;
  let cryptographicallyChecked = 0;
  if (ageIdentityFile) {
    try {
      const identityInfo = await lstat(ageIdentityFile);
      if (!identityInfo.isFile() || identityInfo.isSymbolicLink()) throw new Error('backup_identity_not_a_regular_file');
    } catch (error) {
      return { name, status: 'failed', checked: 0, failures: [error?.message || 'backup_identity_unreadable'] };
    }
  }

  const names = await readdir(root);
  for (const archiveName of names.filter(item => pattern.test(item)).sort()) {
    const archivePath = path.join(root, archiveName);
    const checksumPath = archivePath + '.sha256';
    try {
      const archiveInfo = await lstat(archivePath);
      const checksumInfo = await lstat(checksumPath);
      if (archiveInfo.isSymbolicLink() || !archiveInfo.isFile()) throw new Error('backup_archive_not_a_regular_file');
      if (checksumInfo.isSymbolicLink() || !checksumInfo.isFile()) throw new Error('backup_checksum_not_a_regular_file');
      const checksumText = await readFile(checksumPath, 'utf8');
      const match = checksumText.match(/^([a-f0-9]{64})\s+\*?([^\r\n]+)\s*$/i);
      if (!match || match[2] !== archiveName) throw new Error('backup_checksum_malformed_or_filename_mismatch');
      const actual = await sha256File(archivePath);
      if (actual.toLowerCase() !== match[1].toLowerCase()) throw new Error('backup_checksum_mismatch');
      if (ageIdentityFile) {
        const format = archiveName.endsWith('.dump.age') ? 'postgres' : 'tar';
        await archiveValidator(archivePath, ageIdentityFile, format);
        cryptographicallyChecked += 1;
      }
      checked += 1;
    } catch (error) {
      failures.push(error?.message || 'backup_verification_failed');
    }
  }
  if (checked === 0 && failures.length === 0) failures.push('no_encrypted_backup_found');
  const result = { name, status: failures.length ? 'failed' : 'verified', checked, failures };
  if (ageIdentityFile) result.cryptographicallyChecked = cryptographicallyChecked;
  return result;
}

export async function verifyConfiguredEncryptedBackups(env = process.env) {
  const results = [];
  for (const set of BACKUP_SETS) {
    results.push(await verifyEncryptedBackupDirectory(env[set.directoryEnv], {
      name: set.name,
      pattern: set.pattern,
      ageIdentityFile: env.AGE_IDENTITY_FILE
    }));
  }
  const configured = results.filter(result => result.status !== 'not_configured');
  return {
    status: results.some(result => result.status === 'failed') ? 'failed'
      : configured.length === 0 ? 'not_configured'
        : configured.length !== results.length ? 'partially_configured' : 'verified',
    cryptographic_validation: env.AGE_IDENTITY_FILE ? 'enabled' : 'not_configured',
    results
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  verifyConfiguredEncryptedBackups()
    .then(report => {
      console.log(JSON.stringify(report, null, 2));
      if (report.status === 'failed') process.exitCode = 1;
      else if (report.status === 'partially_configured' || report.status === 'not_configured') process.exitCode = 2;
    })
    .catch(error => {
      console.error('Encrypted backup verification failed:', error?.message || 'unknown error');
      process.exitCode = 1;
    });
}
