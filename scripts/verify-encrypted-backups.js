import 'dotenv/config';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
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

export async function verifyEncryptedBackupDirectory(directory, { pattern, name }) {
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
      checked += 1;
    } catch (error) {
      failures.push(error?.message || 'backup_verification_failed');
    }
  }
  if (checked === 0 && failures.length === 0) failures.push('no_encrypted_backup_found');
  return { name, status: failures.length ? 'failed' : 'verified', checked, failures };
}

export async function verifyConfiguredEncryptedBackups(env = process.env) {
  const results = [];
  for (const set of BACKUP_SETS) {
    results.push(await verifyEncryptedBackupDirectory(env[set.directoryEnv], {
      name: set.name,
      pattern: set.pattern
    }));
  }
  const configured = results.filter(result => result.status !== 'not_configured');
  return {
    status: results.some(result => result.status === 'failed') ? 'failed'
      : configured.length === 0 ? 'not_configured'
        : configured.length !== results.length ? 'partially_configured' : 'verified',
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
