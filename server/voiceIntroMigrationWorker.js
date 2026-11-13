import {
  claimNextVoiceIntroMigration,
  completeVoiceIntroMigrationAfterRollbackWindow,
  getVoiceIntroMigrationLeaseRecord,
  releaseVoiceIntroMigrationLease,
  switchVoiceIntroMigrationReference,
  transitionVoiceIntroMigrationState
} from './voiceIntroMigrationRepository.js';
import {
  authenticateVoiceIntroMigrationSource,
  stageVoiceIntroMigrationCiphertext,
  verifyVoiceIntroMigrationStage
} from './voiceIntroMigrationFiles.js';

const DEFAULT_ROLLBACK_WINDOW_MS = 24 * 60 * 60 * 1000;

function validateRollbackWindow(value) {
  if (!Number.isSafeInteger(value) || value < 60_000 || value > 7 * 24 * 60 * 60 * 1000) {
    throw new RangeError('rollback_window_invalid');
  }
  return value;
}

/**
 * Process at most one leased journal row. This is deliberately a library
 * entrypoint only: no scheduler, CLI apply flag, or automatic migration is
 * installed by importing this module.
 */
export async function processNextVoiceIntroMigration(pool, {
  workerId,
  storageRoot,
  keyring,
  leaseDurationMs = 30_000,
  rollbackWindowMs = DEFAULT_ROLLBACK_WINDOW_MS
} = {}) {
  validateRollbackWindow(rollbackWindowMs);
  if (!keyring || !(keyring.keys instanceof Map)) throw new TypeError('versioned_voice_keyring_required');
  const lease = await claimNextVoiceIntroMigration(pool, { workerId, leaseDurationMs });
  if (!lease) return { status: 'idle' };

  const leaseIdentity = {
    id: lease.id,
    token: lease.lease_token,
    generation: Number(lease.lease_generation)
  };
  let outcome = { status: 'lease_lost' };

  try {
    for (let step = 0; step < 8; step += 1) {
      const record = await getVoiceIntroMigrationLeaseRecord(pool, leaseIdentity);
      if (!record) {
        outcome = { status: 'lease_lost' };
        break;
      }

      if (record.state === 'planned') {
        const authenticated = await authenticateVoiceIntroMigrationSource({
          storageRoot,
          sourcePath: record.source_path,
          sourceSha256: record.source_sha256,
          sourceFormat: record.source_format,
          keyring
        });
        authenticated.plaintext.fill(0);
        const moved = await transitionVoiceIntroMigrationState(pool, {
          ...leaseIdentity,
          expectedState: 'planned',
          expectedVersion: Number(record.version),
          nextState: 'source_authenticated'
        });
        if (!moved) {
          outcome = { status: 'cas_conflict' };
          break;
        }
        continue;
      }

      if (record.state === 'source_authenticated') {
        const authenticated = await authenticateVoiceIntroMigrationSource({
          storageRoot,
          sourcePath: record.source_path,
          sourceSha256: record.source_sha256,
          sourceFormat: record.source_format,
          keyring
        });
        try {
          const staged = await stageVoiceIntroMigrationCiphertext({
            storageRoot,
            journalId: record.id,
            sourcePath: record.source_path,
            plaintext: authenticated.plaintext,
            targetKeyId: record.target_key_id,
            keyring
          });
          const moved = await transitionVoiceIntroMigrationState(pool, {
            ...leaseIdentity,
            expectedState: 'source_authenticated',
            expectedVersion: Number(record.version),
            nextState: 'staged_authenticated',
            patch: staged
          });
          if (!moved) {
            outcome = { status: 'cas_conflict' };
            break;
          }
        } finally {
          authenticated.plaintext.fill(0);
        }
        continue;
      }

      if (record.state === 'staged_authenticated') {
        const authenticated = await authenticateVoiceIntroMigrationSource({
          storageRoot,
          sourcePath: record.source_path,
          sourceSha256: record.source_sha256,
          sourceFormat: record.source_format,
          keyring
        });
        try {
          await verifyVoiceIntroMigrationStage({
            storageRoot,
            stagedPath: record.staged_path,
            stagedSha256: record.staged_sha256,
            plaintext: authenticated.plaintext,
            keyring,
            targetKeyId: record.target_key_id
          });
        } finally {
          authenticated.plaintext.fill(0);
        }
        const switched = await switchVoiceIntroMigrationReference(pool, {
          ...leaseIdentity,
          expectedVersion: Number(record.version),
          voiceIntroId: record.voice_intro_id,
          sourcePath: record.source_path,
          stagedPath: record.staged_path
        });
        if (!switched) {
          outcome = { status: 'reference_conflict' };
          break;
        }
        continue;
      }

      if (record.state === 'reference_switched') {
        const moved = await transitionVoiceIntroMigrationState(pool, {
          ...leaseIdentity,
          expectedState: 'reference_switched',
          expectedVersion: Number(record.version),
          nextState: 'rollback_window',
          patch: { rollbackWindowMs }
        });
        if (!moved) {
          outcome = { status: 'cas_conflict' };
          break;
        }
        continue;
      }

      if (record.state === 'rollback_window') {
        const deadline = new Date(record.rollback_deadline).getTime();
        if (!Number.isFinite(deadline)) {
          throw new Error('migration_rollback_deadline_invalid');
        }
        if (deadline > Date.now()) {
          outcome = { status: 'rollback_window' };
          break;
        }
        const completed = await completeVoiceIntroMigrationAfterRollbackWindow(pool, {
          ...leaseIdentity,
          expectedVersion: Number(record.version)
        });
        outcome = completed
          ? { status: 'completed', journalVersion: Number(completed.version) }
          : { status: 'cas_conflict' };
        break;
      }

      outcome = { status: 'unsupported_state' };
      break;
    }
  } finally {
    try {
      await releaseVoiceIntroMigrationLease(pool, leaseIdentity);
    } catch {
      // An expired lease is reclaimed by the next worker; never mask the
      // processing result with a best-effort release failure.
    }
  }

  return outcome;
}

export const VOICE_INTRO_MIGRATION_DEFAULT_ROLLBACK_WINDOW_MS = DEFAULT_ROLLBACK_WINDOW_MS;
