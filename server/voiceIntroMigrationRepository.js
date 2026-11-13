import { randomUUID } from 'node:crypto';
import { withPooledTransaction } from './withPooledTransaction.js';

const TERMINAL_STATES = new Set(['completed', 'rolled_back']);
const NEXT_STATES = Object.freeze({
  planned: new Set(['source_authenticated']),
  source_authenticated: new Set(['staged_authenticated']),
  staged_authenticated: new Set(['reference_switched']),
  reference_switched: new Set(['rollback_window', 'rolled_back']),
  rollback_window: new Set(['completed', 'rolled_back']),
  completed: new Set(),
  rolled_back: new Set()
});

const DEFAULT_LEASE_MS = 30_000;
const MAX_LEASE_MS = 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

function requireUuid(value, name) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new TypeError(name + '_invalid');
  }
}

function requireWorkerId(value) {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > 128) {
    throw new TypeError('worker_id_invalid');
  }
  return value;
}

function requireLeaseDuration(value) {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > MAX_LEASE_MS) {
    throw new RangeError('lease_duration_invalid');
  }
  return value;
}

function requireVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('journal_version_invalid');
  }
}

function requireState(value) {
  if (!Object.hasOwn(NEXT_STATES, value)) throw new TypeError('journal_state_invalid');
}

function validateTransitionPatch(nextState, patch) {
  const value = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const allowed = nextState === 'staged_authenticated'
    ? new Set(['stagedPath', 'stagedSha256', 'errorCode'])
    : nextState === 'rollback_window'
      ? new Set(['rollbackWindowMs', 'errorCode'])
      : new Set(['errorCode']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError('journal_transition_patch_invalid');
  }
  if (nextState === 'staged_authenticated') {
    if (typeof value.stagedPath !== 'string' || value.stagedPath.length < 1 || value.stagedPath.length > 2048) {
      throw new TypeError('staged_path_invalid');
    }
    if (!SHA256.test(value.stagedSha256 || '')) throw new TypeError('staged_sha256_invalid');
  }
  if (nextState === 'rollback_window' &&
      (!Number.isSafeInteger(value.rollbackWindowMs) || value.rollbackWindowMs < 60_000 || value.rollbackWindowMs > 7 * 24 * 60 * 60 * 1000)) {
    throw new RangeError('rollback_window_invalid');
  }
  if (value.errorCode !== undefined && value.errorCode !== null
      && (typeof value.errorCode !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(value.errorCode))) {
    throw new TypeError('migration_error_code_invalid');
  }
  return value;
}

/**
 * Atomically claim the oldest eligible journal row. The row lock is held only
 * for the short claim transaction; the random token and generation fence all
 * subsequent writes made by this worker.
 */
export async function claimNextVoiceIntroMigration(pool, {
  workerId,
  leaseDurationMs = DEFAULT_LEASE_MS,
  token = randomUUID()
} = {}) {
  requireWorkerId(workerId);
  requireLeaseDuration(leaseDurationMs);
  requireUuid(token, 'lease_token');

  return withPooledTransaction(pool, async client => {
    const result = await client.query(
      `WITH candidate AS (
         SELECT id
         FROM voice_intro_migration_journal
         WHERE state NOT IN ('completed', 'rolled_back')
           AND (lease_token IS NULL OR lease_expires_at <= statement_timestamp())
         ORDER BY created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE voice_intro_migration_journal AS journal
       SET lease_token = $1,
           lease_owner = $2,
           lease_claimed_at = statement_timestamp(),
           lease_expires_at = statement_timestamp() + ($3::bigint * INTERVAL '1 millisecond'),
           lease_generation = journal.lease_generation + 1
       FROM candidate
       WHERE journal.id = candidate.id
       RETURNING journal.id, journal.state, journal.version,
                 journal.lease_token, journal.lease_owner,
                 journal.lease_claimed_at, journal.lease_expires_at,
                 journal.lease_generation`,
      [token, workerId, leaseDurationMs]
    );
    return result.rows[0] || null;
  });
}

/** Extend only the currently active lease; stale or expired owners get null. */
export async function renewVoiceIntroMigrationLease(pool, {
  id,
  token,
  generation,
  leaseDurationMs = DEFAULT_LEASE_MS
} = {}) {
  requireUuid(id, 'journal_id');
  requireUuid(token, 'lease_token');
  if (!Number.isSafeInteger(generation) || generation < 1) throw new TypeError('lease_generation_invalid');
  requireLeaseDuration(leaseDurationMs);

  return withPooledTransaction(pool, async client => {
    const result = await client.query(
      `UPDATE voice_intro_migration_journal
       SET lease_expires_at = GREATEST(lease_expires_at, statement_timestamp())
         + ($4::bigint * INTERVAL '1 millisecond')
       WHERE id = $1 AND lease_token = $2 AND lease_generation = $3
         AND lease_expires_at > statement_timestamp()
       RETURNING id, lease_expires_at, lease_generation`,
      [id, token, generation, leaseDurationMs]
    );
    return result.rows[0] || null;
  });
}

/** Release is fenced and succeeds only while this exact lease is still live. */
export async function releaseVoiceIntroMigrationLease(pool, { id, token, generation } = {}) {
  requireUuid(id, 'journal_id');
  requireUuid(token, 'lease_token');
  if (!Number.isSafeInteger(generation) || generation < 1) throw new TypeError('lease_generation_invalid');

  return withPooledTransaction(pool, async client => {
    const result = await client.query(
      `UPDATE voice_intro_migration_journal
       SET lease_token = NULL, lease_owner = NULL,
           lease_claimed_at = NULL, lease_expires_at = NULL
       WHERE id = $1 AND lease_token = $2 AND lease_generation = $3
         AND lease_expires_at > statement_timestamp()
       RETURNING id, lease_generation`,
      [id, token, generation]
    );
    return result.rows[0] || null;
  });
}

/**
 * Compare-and-swap a journal state transition under the caller's live lease.
 * PostgreSQL's journal trigger appends the immutable event in this transaction.
 */
export async function transitionVoiceIntroMigrationState(pool, {
  id,
  token,
  generation,
  expectedState,
  expectedVersion,
  nextState,
  patch = {}
} = {}) {
  requireUuid(id, 'journal_id');
  requireUuid(token, 'lease_token');
  if (!Number.isSafeInteger(generation) || generation < 1) throw new TypeError('lease_generation_invalid');
  requireState(expectedState);
  requireState(nextState);
  requireVersion(expectedVersion);
  if (!NEXT_STATES[expectedState].has(nextState)) throw new Error('migration_transition_not_allowed');
  if (TERMINAL_STATES.has(expectedState)) throw new Error('migration_transition_terminal');
  if (['reference_switched', 'completed', 'rolled_back'].includes(nextState)) {
    throw new Error('migration_transition_requires_atomic_repository_method');
  }
  const values = validateTransitionPatch(nextState, patch);

  return withPooledTransaction(pool, async client => {
    const result = await client.query(
      `UPDATE voice_intro_migration_journal
       SET state = $5,
           version = version + 1,
           staged_path = CASE WHEN $5 = 'staged_authenticated' THEN $6 ELSE staged_path END,
           staged_sha256 = CASE WHEN $5 = 'staged_authenticated' THEN $7 ELSE staged_sha256 END,
           staged_authenticated_at = CASE WHEN $5 = 'staged_authenticated'
             THEN statement_timestamp() ELSE staged_authenticated_at END,
           rollback_deadline = CASE WHEN $5 = 'rollback_window'
             THEN statement_timestamp() + ($10::bigint * INTERVAL '1 millisecond')
             ELSE rollback_deadline END,
           last_error_code = $8,
           updated_at = statement_timestamp()
       WHERE id = $1
         AND state = $2
         AND version = $3
         AND lease_token = $4
         AND lease_generation = $9
         AND lease_expires_at > statement_timestamp()
       RETURNING id, state, version, updated_at, source_authenticated_at,
                 staged_path, staged_sha256, staged_authenticated_at,
                 reference_switched_at, rollback_deadline, completed_at,
                 lease_generation`,
      [
        id, expectedState, expectedVersion, token, nextState,
        values.stagedPath ?? null, values.stagedSha256 ?? null,
        values.errorCode ?? null, generation, values.rollbackWindowMs ?? 0
      ]
    );
    return result.rows[0] || null;
  });
}

export const VOICE_INTRO_MIGRATION_DEFAULT_LEASE_MS = DEFAULT_LEASE_MS;


/**
 * Switch the profile reference and journal state in one database transaction.
 * The file itself must already exist and have been authenticated by the caller.
 * Repeating the operation is safe when the profile already points at stagedPath.
 */
export async function switchVoiceIntroMigrationReference(pool, {
  id, token, generation, expectedVersion,
  voiceIntroId, sourcePath, stagedPath
} = {}) {
  requireUuid(id, 'journal_id');
  requireUuid(token, 'lease_token');
  requireUuid(voiceIntroId, 'voice_intro_id');
  if (!Number.isSafeInteger(generation) || generation < 1) throw new TypeError('lease_generation_invalid');
  requireVersion(expectedVersion);
  if (typeof sourcePath !== 'string' || sourcePath.length < 1 || sourcePath.length > 2048 ||
      typeof stagedPath !== 'string' || stagedPath.length < 1 || stagedPath.length > 2048 ||
      sourcePath === stagedPath) throw new TypeError('migration_reference_path_invalid');

  return withPooledTransaction(pool, async client => {
    const switched = await client.query(
      `UPDATE profile_voice_intros
       SET storage_path = $3, updated_at = statement_timestamp()
       WHERE id = $1 AND storage_path = $2
       RETURNING id, storage_path`,
      [voiceIntroId, sourcePath, stagedPath]
    );
    if (switched.rowCount === 0) {
      const current = await client.query(
        'SELECT storage_path FROM profile_voice_intros WHERE id = $1 FOR UPDATE',
        [voiceIntroId]
      );
      if (current.rows[0]?.storage_path !== stagedPath) return null;
    }

    const journal = await client.query(
      `UPDATE voice_intro_migration_journal
       SET state = 'reference_switched', version = version + 1,
           updated_at = statement_timestamp()
       WHERE id = $1 AND voice_intro_id = $2
         AND state = 'staged_authenticated' AND version = $3
         AND source_path = $4 AND staged_path = $5
         AND lease_token = $6 AND lease_generation = $7
         AND lease_expires_at > statement_timestamp()
       RETURNING id, state, version, reference_switched_at, staged_path`,
      [id, voiceIntroId, expectedVersion, sourcePath, stagedPath, token, generation]
    );
    if (!journal.rows[0]) throw new Error('migration_reference_switch_cas_conflict');
    return journal.rows[0];
  });
}

/**
 * End the rollback window and enqueue the old ciphertext for the existing
 * private-media purge worker. The journal transition and enqueue are atomic.
 */
export async function completeVoiceIntroMigrationAfterRollbackWindow(pool, {
  id, token, generation, expectedVersion
} = {}) {
  requireUuid(id, 'journal_id');
  requireUuid(token, 'lease_token');
  if (!Number.isSafeInteger(generation) || generation < 1) throw new TypeError('lease_generation_invalid');
  requireVersion(expectedVersion);

  return withPooledTransaction(pool, async client => {
    const completed = await client.query(
      `UPDATE voice_intro_migration_journal
       SET state = 'completed', version = version + 1,
           updated_at = statement_timestamp()
       WHERE id = $1 AND state = 'rollback_window' AND version = $2
         AND lease_token = $3 AND lease_generation = $4
         AND lease_expires_at > statement_timestamp()
         AND rollback_deadline IS NOT NULL
         AND rollback_deadline <= statement_timestamp()
       RETURNING id, source_path, state, version, completed_at`,
      [id, expectedVersion, token, generation]
    );
    const row = completed.rows[0];
    if (!row) return null;
    await client.query(
      `INSERT INTO private_voice_intro_purge_queue (storage_path)
       VALUES ($1) ON CONFLICT (storage_path) DO NOTHING`,
      [row.source_path]
    );
    return row;
  });
}
