const STATES = Object.freeze([
  'planned',
  'source_authenticated',
  'staged_authenticated',
  'reference_switched',
  'rollback_window',
  'completed',
  'rolled_back'
]);

const NEXT = Object.freeze({
  planned: new Set(['source_authenticated']),
  source_authenticated: new Set(['staged_authenticated']),
  staged_authenticated: new Set(['reference_switched']),
  reference_switched: new Set(['rollback_window', 'rolled_back']),
  rollback_window: new Set(['completed', 'rolled_back']),
  completed: new Set(),
  rolled_back: new Set()
});

const SHA256 = /^[a-f0-9]{64}$/i;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireText(value, name, max = 2048) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) {
    throw new TypeError(name + '_invalid');
  }
  return value;
}

export function createVoiceIntroMigrationJournalEntry({
  id,
  sourcePath,
  sourceSha256,
  sourceFormat,
  targetKeyId,
  createdAt = new Date().toISOString()
} = {}) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new TypeError('migration_entry_id_invalid');
  requireText(sourcePath, 'source_path');
  if (!SHA256.test(sourceSha256 || '')) throw new TypeError('source_sha256_invalid');
  if (!['VOWVOICE1', 'VOWVOICE2'].includes(sourceFormat)) throw new TypeError('source_format_invalid');
  if (!KEY_ID.test(targetKeyId || '')) throw new TypeError('target_key_id_invalid');
  if (!Number.isFinite(Date.parse(createdAt))) throw new TypeError('created_at_invalid');

  return Object.freeze({
    schemaVersion: 1,
    id,
    state: 'planned',
    sourcePath,
    sourceSha256: sourceSha256.toLowerCase(),
    sourceFormat,
    targetKeyId,
    stagedPath: null,
    stagedSha256: null,
    createdAt,
    updatedAt: createdAt,
    switchedAt: null,
    completedAt: null,
    lastErrorCode: null
  });
}

export function transitionVoiceIntroMigrationJournalEntry(entry, nextState, {
  now = new Date().toISOString(),
  stagedPath,
  stagedSha256,
  errorCode
} = {}) {
  if (!entry || entry.schemaVersion !== 1 || !STATES.includes(entry.state)) {
    throw new TypeError('migration_journal_entry_invalid');
  }
  if (!STATES.includes(nextState) || !NEXT[entry.state].has(nextState)) {
    throw new Error('migration_journal_transition_not_allowed');
  }
  if (!Number.isFinite(Date.parse(now)) || Date.parse(now) < Date.parse(entry.updatedAt)) {
    throw new TypeError('migration_journal_timestamp_invalid');
  }

  const updated = { ...entry, state: nextState, updatedAt: now, lastErrorCode: null };
  if (nextState === 'staged_authenticated') {
    requireText(stagedPath, 'staged_path');
    if (!SHA256.test(stagedSha256 || '')) throw new TypeError('staged_sha256_invalid');
    if (stagedPath === entry.sourcePath) throw new Error('staged_path_must_differ_from_source');
    updated.stagedPath = stagedPath;
    updated.stagedSha256 = stagedSha256.toLowerCase();
  }
  if (nextState === 'reference_switched') {
    if (!entry.stagedPath || !entry.stagedSha256) throw new Error('verified_staged_artifact_required');
    updated.switchedAt = now;
  }
  if (nextState === 'completed' || nextState === 'rolled_back') {
    updated.completedAt = now;
  }
  return Object.freeze(updated);
}

export function isVoiceIntroMigrationJournalState(value) {
  return STATES.includes(value);
}

export const VOICE_INTRO_MIGRATION_JOURNAL_STATES = STATES;
