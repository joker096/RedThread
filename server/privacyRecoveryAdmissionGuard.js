import { lstatSync, readFileSync, realpathSync } from 'node:fs';

export function assertPrivacyRecoveryAdmission(env = process.env) {
  if (env.PRIVACY_RECOVERY_REQUIRE_ADMISSION !== 'true') return false;

  const lockFile = env.PRIVACY_RECOVERY_WRITER_LOCK_FILE;
  if (typeof lockFile !== 'string' || !lockFile.startsWith('/')) {
    throw new Error('privacy recovery admission requires an absolute writer lock path');
  }

  let expectedPath;
  let descriptorPath;
  try {
    expectedPath = realpathSync(lockFile);
    descriptorPath = realpathSync('/proc/self/fd/9');
  } catch {
    throw new Error('privacy recovery admission requires the inherited shared lock on FD 9');
  }

  if (descriptorPath !== expectedPath) {
    throw new Error('privacy recovery admission FD 9 does not reference the configured lock inode');
  }

  let descriptorInfo;
  try {
    descriptorInfo = readFileSync('/proc/self/fdinfo/9', 'utf8');
  } catch {
    throw new Error('privacy recovery admission cannot inspect inherited FD 9');
  }
  if (!/^lock:\s*\d+:\s+FLOCK\s+ADVISORY\s+READ\b/m.test(descriptorInfo)) {
    throw new Error('privacy recovery admission requires a live shared flock on FD 9');
  }

  const marker = lockFile + '.maintenance';
  try {
    const markerStat = lstatSync(marker);
    if (markerStat.isSymbolicLink()) {
      throw new Error('privacy recovery maintenance marker must not be a symlink');
    }
    throw new Error('privacy recovery admission is closed for maintenance');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  return true;
}
